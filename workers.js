
import html from './main.html';

const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

const PRIVATE_FIELDS = [
  'full name',
  'email',
  'phone',
  'linkedin',
  'role'
];

// =============================================
// UTILITIES
// =============================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8'
    }
  });
}

function safeString(value) {
  if (value === null || value === undefined) return '';

  if (typeof value === 'string') return value;

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function validResponses(responses) {
  return (
    responses !== null &&
    typeof responses === 'object' &&
    !Array.isArray(responses)
  );
}

function normalize(value) {
  return safeString(value).trim().toLowerCase();
}

function randomId() {
  return crypto.randomUUID();
}

function isPrivateField(key) {
  return PRIVATE_FIELDS.includes(normalize(key));
}

function getResponseValue(responses, wantedKey) {
  const target = normalize(wantedKey);

  const entry = Object.entries(responses || {}).find(
    ([key]) => normalize(key) === target
  );

  return entry ? entry[1] : '';
}

function cleanResponses(responses) {
  return Object.fromEntries(
    Object.entries(responses || {}).filter(
      ([key]) => !isPrivateField(key)
    )
  );
}

function isGibberishOrSpam(value) {
  const text = safeString(value).trim();

  if (text.length < 2) return true;

  const letters = text.replace(/[^a-zA-Z]/g, '');

  if (letters.length >= 5) {
    const uniqueLetters = new Set(letters.toLowerCase()).size;

    if (uniqueLetters <= 2) return true;
  }

  if (/^(.)\1{4,}$/.test(text)) return true;

  return false;
}

function extractAIText(result) {
  if (typeof result === 'string') return result;

  if (typeof result?.response === 'string') {
    return result.response;
  }

  if (typeof result?.result?.response === 'string') {
    return result.result.response;
  }

  if (typeof result?.choices?.[0]?.message?.content === 'string') {
    return result.choices[0].message.content;
  }

  if (typeof result?.output_text === 'string') {
    return result.output_text;
  }

  if (typeof result?.response === 'object' && result.response !== null) {
    return JSON.stringify(result.response);
  }

  throw new Error(
    'Unexpected AI response format: ' +
    safeString(result).slice(0, 1000)
  );
}

// Extracts the first complete JSON object without relying
// on a greedy regular expression.
function extractJSON(text) {
  const cleaned = safeString(text)
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf('{');

  if (start === -1) {
    throw new Error(
      'AI did not return JSON: ' + cleaned.slice(0, 500)
    );
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;

      if (depth === 0) {
        return JSON.parse(cleaned.slice(start, i + 1));
      }
    }
  }

  throw new Error('AI returned incomplete JSON.');
}

async function hashString(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);

  return Array.from(new Uint8Array(hash))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function parseJSON(value, fallback = {}) {
  if (typeof value === 'object' && value !== null) {
    return value;
  }

  try {
    return JSON.parse(value || '{}');
  } catch {
    return fallback;
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) return fallback;

  return Math.max(min, Math.min(max, number));
}

function normalizeRole(value) {
  return normalize(value);
}

// =============================================
// AI REQUEST
// =============================================

async function runAIJson(AI, prompt, options = {}) {
  if (!AI || typeof AI.run !== 'function') {
    throw new Error('Cloudflare AI binding is unavailable.');
  }

  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const requestOptions = {
        messages: [
          {
            role: 'system',
            content:
              'Return exactly one valid JSON object. ' +
              'Do not include markdown, explanations, or text outside JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: options.temperature ?? 0,
        max_tokens: options.max_tokens ?? 1200
      };

      // First attempt uses JSON mode.
      // Second attempt uses normal generation in case the
      // model or account rejects response_format.
      if (attempt === 0) {
        requestOptions.response_format = {
          type: 'json_object'
        };
      }

      const result = await AI.run(AI_MODEL, requestOptions);
      const text = extractAIText(result);

      if (!text.trim()) {
        throw new Error('AI returned an empty response.');
      }

      return extractJSON(text);

    } catch (error) {
      lastError = error;

      console.error(
        `AI JSON ATTEMPT ${attempt + 1} FAILED:`,
        error?.stack || error?.message || error
      );
    }
  }

  throw lastError || new Error('AI request failed.');
}

// =============================================
// PERSONALITY FALLBACK
// =============================================

function createFallbackAnalysis(profile, errorMessage = '') {
  const entries = Object.entries(profile || {});

  const usefulAnswers = entries.filter(([key, value]) => {
    return (
      safeString(value).trim().length >= 2 &&
      !isGibberishOrSpam(value)
    );
  });

  const answerCount = usefulAnswers.length;

  // This is only a conservative completeness estimate.
  // It is NOT a personality or compatibility score.
  const quality = Math.min(
    0.75,
    Math.max(0.2, answerCount / Math.max(entries.length, 1))
  );

  return {
    quality_score: quality,
    fit_rating: 'Awaiting AI Analysis',

    personality: {
      work_style: 'Not yet analyzed',
      thinking_style: 'Not yet analyzed',
      social_style: 'Not yet analyzed',
      organization: 'Not yet analyzed',
      motivation: 'Not yet analyzed',
      decision_making: 'Not yet analyzed',
      strengths: [],
      potential_challenges: [
        'Automatic personality analysis could not be completed.'
      ],
      communication_style: 'Not yet analyzed',
      evidence: usefulAnswers.map(([question]) =>
        'Answer provided for: ' + question
      ),
      personality_summary:
        'Fallback profile. Original answers are saved, but personality traits have not been verified.'
    },

    summary:
      `Profile saved with ${answerCount} usable answers. ` +
      'AI personality analysis needs to be retried.',

    status: 'fallback',
    error: errorMessage || 'AI analysis unavailable.'
  };
}

// =============================================
// PERSONALITY ANALYSIS
// =============================================

async function analyzePersonality(AI, responses) {
  const profile = cleanResponses(responses);

  const answerValues = Object.values(profile)
    .map(safeString)
    .filter(value => value.trim().length > 0);

  const usefulAnswers = answerValues.filter(
    answer => !isGibberishOrSpam(answer)
  );

  if (answerValues.length === 0 || usefulAnswers.length === 0) {
    return {
      quality_score: 0,
      fit_rating: 'Poor Match / Unqualified',

      personality: {
        work_style: 'unclear',
        thinking_style: 'unclear',
        social_style: 'unclear',
        organization: 'unclear',
        motivation: 'unclear',
        decision_making: 'unclear',
        strengths: [],
        potential_challenges: ['No usable answers provided.'],
        communication_style: 'unclear',
        evidence: [],
        personality_summary: 'No usable responses were provided.'
      },

      summary: 'Candidate provided no usable responses.',
      status: 'flagged_spam',
      error: null
    };
  }

  const prompt = `
Analyze this person's answers for a mentorship program.

Extract their working preferences, personality tendencies,
communication style, strengths, and possible challenges.

Only make conclusions supported by their answers.
Do not infer traits from writing quality, spelling, or grammar.
Do not invent information.
If something is unknown, write "unclear".

Return a JSON object with these fields:

{
  "quality_score": 0.7,
  "fit_rating": "Moderate Match",
  "work_style": "string",
  "thinking_style": "string",
  "social_style": "string",
  "organization": "string",
  "motivation": "string",
  "decision_making": "string",
  "strengths": ["string"],
  "potential_challenges": ["string"],
  "communication_style": "string",
  "evidence": ["string"],
  "personality_summary": "string"
}

RULES:
- quality_score must be between 0 and 1.
- It measures answer completeness and usefulness.
- It does NOT measure intelligence or personal worth.
- Do not automatically give high scores.
- Do not invent characteristics.
- Be specific about working preferences.
- Use "unclear" when there is insufficient evidence.

PERSON'S ANSWERS:
${JSON.stringify(profile)}
`;

  try {
    const parsed = await runAIJson(AI, prompt, {
      temperature: 0,
      max_tokens: 1400
    });

    const requiredFields = [
      'work_style',
      'thinking_style',
      'social_style',
      'organization',
      'motivation',
      'decision_making',
      'communication_style',
      'personality_summary'
    ];

    const missingFields = requiredFields.filter(
      field => typeof parsed[field] !== 'string'
    );

    if (missingFields.length > 0) {
      throw new Error(
        'AI analysis missing fields: ' +
        missingFields.join(', ')
      );
    }

    const score = Number(parsed.quality_score);

    if (!Number.isFinite(score)) {
      throw new Error('AI returned an invalid quality score.');
    }

    const personality = {
      work_style: parsed.work_style,
      thinking_style: parsed.thinking_style,
      social_style: parsed.social_style,
      organization: parsed.organization,
      motivation: parsed.motivation,
      decision_making: parsed.decision_making,

      strengths: Array.isArray(parsed.strengths)
        ? parsed.strengths.map(safeString)
        : [],

      potential_challenges:
        Array.isArray(parsed.potential_challenges)
          ? parsed.potential_challenges.map(safeString)
          : [],

      communication_style: parsed.communication_style,

      evidence: Array.isArray(parsed.evidence)
        ? parsed.evidence.map(safeString)
        : [],

      personality_summary: parsed.personality_summary
    };

    console.log('PERSONALITY ANALYSIS SUCCESS');

    return {
      quality_score: clampNumber(score, 0, 1, 0.5),
      fit_rating:
        safeString(parsed.fit_rating) || 'Moderate Match',
      personality,
      summary: personality.personality_summary,
      status: 'success',
      error: null
    };

  } catch (error) {
    console.error(
      'PERSONALITY ANALYSIS FAILED:',
      error?.stack || error?.message || error
    );

    return createFallbackAnalysis(
      profile,
      error?.message || 'Unknown analysis error.'
    );
  }
}

// =============================================
// SAVE PROFILE
// =============================================

async function saveProfile(DB, responses, analysis, profileId) {
  const role = safeString(getResponseValue(responses, 'Role'));
  const fullName = safeString(getResponseValue(responses, 'Full Name'));
  const email = safeString(getResponseValue(responses, 'Email'));
  const phone = safeString(getResponseValue(responses, 'Phone'));
  const linkedin = safeString(getResponseValue(responses, 'LinkedIn'));

  await DB.prepare(`
    INSERT INTO personality_profiles (
      id,
      role,
      full_name,
      email,
      phone,
      linkedin,
      quality_score,
      fit_rating,
      personality_summary,
      personality_json,
      analysis_status,
      analysis_error,
      responses,
      match_status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unmatched')

    ON CONFLICT(id) DO UPDATE SET
      role = excluded.role,
      full_name = excluded.full_name,
      email = excluded.email,
      phone = excluded.phone,
      linkedin = excluded.linkedin,
      quality_score = excluded.quality_score,
      fit_rating = excluded.fit_rating,
      personality_summary = excluded.personality_summary,
      personality_json = excluded.personality_json,
      analysis_status = excluded.analysis_status,
      analysis_error = excluded.analysis_error,
      responses = excluded.responses,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    profileId,
    role,
    fullName,
    email,
    phone,
    linkedin,
    analysis.quality_score,
    analysis.fit_rating,
    analysis.summary,
    JSON.stringify(analysis.personality),
    analysis.status,
    analysis.error,
    JSON.stringify(responses)
  ).run();

  await DB.prepare(`
    DELETE FROM candidate_rankings
    WHERE evaluator_id = ?
  `).bind(profileId).run();

  return true;
}

// =============================================
// AVAILABILITY
// =============================================

function extractAvailabilityDays(responses) {
  for (const [key, value] of Object.entries(responses || {})) {
    if (normalize(key).includes('days of the week')) {
      if (Array.isArray(value)) {
        return value.map(normalize).filter(Boolean);
      }

      return safeString(value)
        .split(/[,;]+/)
        .map(normalize)
        .filter(Boolean);
    }
  }

  return [];
}

function availabilityCompatible(personA, personB) {
  const daysA = extractAvailabilityDays(
    parseJSON(personA.responses)
  );

  const daysB = extractAvailabilityDays(
    parseJSON(personB.responses)
  );

  // Missing availability does not automatically reject a match.
  if (!daysA.length || !daysB.length) return true;

  return daysA.some(day => daysB.includes(day));
}

// =============================================
// COMPARATIVE CANDIDATE DATA
// =============================================

function getPersonality(profile) {
  return parseJSON(profile.personality_json);
}

function createCandidateData(profile) {
  return {
    id: String(profile.id),
    personality: getPersonality(profile),

    // Include original answers so that fallback profiles
    // can still be evaluated using their actual responses.
    answers: cleanResponses(parseJSON(profile.responses)),

    available_days: extractAvailabilityDays(
      parseJSON(profile.responses)
    ),

    analysis_status: profile.analysis_status
  };
}

async function getCandidateSetHash(candidates) {
  const data = candidates
    .map(candidate => ({
      id: String(candidate.id),
      personality_json: candidate.personality_json,
      responses: candidate.responses,
      analysis_status: candidate.analysis_status
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return hashString(JSON.stringify(data));
}

// =============================================
// RANKING CACHE
// =============================================

async function getCachedRanking(DB, evaluatorId, candidateHash) {
  const cached = await DB.prepare(`
    SELECT candidate_set_hash, ranking_json
    FROM candidate_rankings
    WHERE evaluator_id = ?
  `).bind(evaluatorId).first();

  if (!cached || cached.candidate_set_hash !== candidateHash) {
    return null;
  }

  try {
    const ranking = JSON.parse(cached.ranking_json);

    if (!ranking || typeof ranking !== 'object') {
      return null;
    }

    // Never reuse incomplete or fallback rankings.
    for (const evaluation of Object.values(ranking)) {
      if (
        !evaluation ||
        evaluation.fallback === true ||
        !Number.isFinite(Number(evaluation.score))
      ) {
        return null;
      }
    }

    return ranking;

  } catch {
    return null;
  }
}

async function saveCachedRanking(
  DB,
  evaluatorId,
  candidateHash,
  ranking
) {
  await DB.prepare(`
    INSERT INTO candidate_rankings (
      evaluator_id,
      candidate_set_hash,
      ranking_json,
      updated_at
    )
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)

    ON CONFLICT(evaluator_id) DO UPDATE SET
      candidate_set_hash = excluded.candidate_set_hash,
      ranking_json = excluded.ranking_json,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    evaluatorId,
    candidateHash,
    JSON.stringify(ranking)
  ).run();
}

// =============================================
// RANKING FALLBACK
// =============================================

function createFallbackRanking(candidates, reason) {
  const ranking = {};

  for (const candidate of candidates) {
    ranking[String(candidate.id)] = {
      score: 50,
      reasoning:
        'Evaluation could not be completed. This is not a compatibility judgment. ' +
        (reason || 'Please retry the evaluation.'),
      fallback: true
    };
  }

  return ranking;
}

// =============================================
// AI CANDIDATE RANKING
// =============================================

async function rankCandidates(AI, evaluator, candidates, evaluatorRole) {
  const evaluatorData = createCandidateData(evaluator);
  const candidateData = candidates.map(createCandidateData);

  const task = evaluatorRole === 'mentor'
    ? `
You are evaluating mentees for one particular mentor.

Rank the mentees based on how well this mentor could support each person.
Consider which mentee would benefit most from this mentor's approach,
knowledge, communication style, and strengths.
`
    : `
You are evaluating mentors for one particular mentee.

Rank the mentors based on how well each could support this mentee.
Consider which mentor would best understand their needs, help with
their challenges, and support their development.
`;

  const prompt = `
${task}

You must compare ALL candidates.

IMPORTANT:
- Do not use word matching.
- Do not reward identical answers or identical personality descriptions.
- Different personalities can be highly compatible.
- Look for complementary traits and useful differences.
- Consider the actual mentor-mentee relationship.
- Consider communication, working style, motivation, organization,
  thinking style, and decision-making.
- Consider whether the mentor can realistically help the mentee.
- Identify potential conflicts and weaknesses.
- Do not invent information.
- Missing information should lower confidence.
- Do not use names or private information.
- Every candidate must receive a score.
- Scores must reflect suitability, not similarity.
- Use the original answers when personality analysis is unavailable.

PERSON BEING EVALUATED:
${JSON.stringify(evaluatorData)}

AVAILABLE CANDIDATES:
${JSON.stringify(candidateData)}

Return ONLY this JSON structure:

{
  "rankings": [
    {
      "candidate_id": "exact candidate ID",
      "score": 85,
      "reasoning": "Why this candidate is a good or poor choice."
    }
  ]
}

SCORING:
90-100: Exceptional candidate
80-89: Very strong candidate
70-79: Good candidate
60-69: Reasonable candidate
40-59: Weak candidate
0-39: Very poor candidate

RULES:
- Include every candidate ID exactly once.
- Do not create IDs.
- Do not omit candidates.
- Scores must be integers from 0 to 100.
- Do not give high scores without evidence.
- Return a ranking for every candidate.
`;

  try {
    const parsed = await runAIJson(AI, prompt, {
      temperature: 0,
      max_tokens: 2500
    });

    if (!Array.isArray(parsed.rankings)) {
      throw new Error('AI did not return a rankings array.');
    }

    const validIds = new Set(
      candidates.map(candidate => String(candidate.id))
    );

    const rankings = new Map();

    for (const item of parsed.rankings) {
      const id = safeString(item.candidate_id);

      if (!validIds.has(id) || rankings.has(id)) continue;

      const score = Number(item.score);

      if (!Number.isFinite(score)) continue;

      const reasoning = safeString(item.reasoning).trim();

      if (!reasoning) continue;

      rankings.set(id, {
        score: clampNumber(score, 0, 100, 50),
        reasoning,
        fallback: false
      });
    }

    const completeRanking = {};
    let incomplete = false;

    for (const candidate of candidates) {
      const id = String(candidate.id);
      const evaluation = rankings.get(id);

      if (evaluation) {
        completeRanking[id] = evaluation;
      } else {
        incomplete = true;

        completeRanking[id] = {
          score: 50,
          reasoning:
            'AI did not provide a valid evaluation for this candidate.',
          fallback: true
        };
      }
    }

    if (incomplete) {
      console.warn(
        'Ranking was incomplete. Missing evaluations use fallback scores.'
      );
    }

    return completeRanking;

  } catch (error) {
    console.error(
      'CANDIDATE RANKING ERROR:',
      evaluator.id,
      error?.stack || error?.message || error
    );

    return createFallbackRanking(
      candidates,
      'AI ranking failed.'
    );
  }
}

// =============================================
// GET OR CREATE RANKING
// =============================================

async function getOrCreateRanking(
  DB,
  AI,
  evaluator,
  candidates,
  evaluatorRole
) {
  if (!candidates.length) return {};

  const candidateHash = await getCandidateSetHash(candidates);

  const cached = await getCachedRanking(
    DB,
    evaluator.id,
    candidateHash
  );

  if (cached) {
    // Check that every candidate is represented.
    const complete = candidates.every(candidate =>
      Object.prototype.hasOwnProperty.call(
        cached,
        String(candidate.id)
      )
    );

    if (complete) {
      console.log('Ranking cache hit:', evaluator.id);
      return cached;
    }
  }

  console.log(
    'AI comparing candidates for:',
    evaluator.full_name,
    'Candidate count:',
    candidates.length
  );

  const ranking = await rankCandidates(
    AI,
    evaluator,
    candidates,
    evaluatorRole
  );

  // Do not cache failed or partial rankings.
  const hasFallback = Object.values(ranking).some(
    item => item.fallback === true
  );

  if (!hasFallback) {
    try {
      await saveCachedRanking(
        DB,
        evaluator.id,
        candidateHash,
        ranking
      );
    } catch (error) {
      console.error('RANKING CACHE SAVE ERROR:', error);
    }
  }

  return ranking;
}

// =============================================
// MATCHING ENGINE
// =============================================

async function runMatchingEngine(DB, AI) {
  console.log('========== COMPARATIVE AI MATCHING ==========');

  if (!DB) {
    return {
      created: 0,
      error: 'Missing database binding.'
    };
  }

  try {
    const { results: candidates } = await DB.prepare(`
      SELECT *
      FROM personality_profiles
      WHERE match_status = 'unmatched'
        AND quality_score > 0.1
        AND LOWER(role) IN ('mentor', 'mentee')
        AND personality_json IS NOT NULL
        AND analysis_status IN ('success', 'fallback')
      ORDER BY quality_score DESC
    `).all();

    const allCandidates = candidates || [];

    const mentors = allCandidates.filter(
      person => normalizeRole(person.role) === 'mentor'
    );

    const mentees = allCandidates.filter(
      person => normalizeRole(person.role) === 'mentee'
    );

    console.log({
      candidates: allCandidates.length,
      mentors: mentors.length,
      mentees: mentees.length
    });

    if (!mentors.length || !mentees.length) {
      return {
        created: 0,
        evaluatedMentors: 0,
        evaluatedMentees: 0,
        compatiblePairs: 0
      };
    }

    const { results: declinedMatches } = await DB.prepare(`
      SELECT mentor_id, mentee_id
      FROM matches
      WHERE status = 'declined'
    `).all();

    const declinedPairs = new Set(
      (declinedMatches || []).map(match =>
        `${match.mentor_id}:${match.mentee_id}`
      )
    );

    // STEP 1: Every mentor ranks available mentees.

    const mentorRankings = new Map();

    for (const mentor of mentors) {
      const availableMentees = mentees.filter(mentee =>
        availabilityCompatible(mentor, mentee)
      );

      if (!availableMentees.length) continue;

      try {
        const ranking = await getOrCreateRanking(
          DB,
          AI,
          mentor,
          availableMentees,
          'mentor'
        );

        mentorRankings.set(String(mentor.id), ranking);

      } catch (error) {
        console.error(
          'MENTOR RANKING PROCESS ERROR:',
          mentor.id,
          error
        );
      }
    }

    // STEP 2: Every mentee ranks available mentors.

    const menteeRankings = new Map();

    for (const mentee of mentees) {
      const availableMentors = mentors.filter(mentor =>
        availabilityCompatible(mentor, mentee)
      );

      if (!availableMentors.length) continue;

      try {
        const ranking = await getOrCreateRanking(
          DB,
          AI,
          mentee,
          availableMentors,
          'mentee'
        );

        menteeRankings.set(String(mentee.id), ranking);

      } catch (error) {
        console.error(
          'MENTEE RANKING PROCESS ERROR:',
          mentee.id,
          error
        );
      }
    }

    // STEP 3: Combine both people's preferences.

    const possiblePairs = [];

    for (const mentor of mentors) {
      const mentorRanking = mentorRankings.get(
        String(mentor.id)
      );

      if (!mentorRanking) continue;

      for (const mentee of mentees) {
        const menteeRanking = menteeRankings.get(
          String(mentee.id)
        );

        if (!menteeRanking) continue;

        if (!availabilityCompatible(mentor, mentee)) continue;

        const pairKey = `${mentor.id}:${mentee.id}`;

        if (declinedPairs.has(pairKey)) continue;

        const mentorPreference =
          mentorRanking[String(mentee.id)];

        const menteePreference =
          menteeRanking[String(mentor.id)];

        if (!mentorPreference || !menteePreference) continue;

        // Never use fallback evaluations to create matches.
        if (mentorPreference.fallback) continue;
        if (menteePreference.fallback) continue;

        const mentorScore = Number(mentorPreference.score);
        const menteeScore = Number(menteePreference.score);

        if (!Number.isFinite(mentorScore)) continue;
        if (!Number.isFinite(menteeScore)) continue;

        // Both people must consider the pairing reasonable.
        if (mentorScore < 60 || menteeScore < 60) continue;

        const mutualScore = (mentorScore + menteeScore) / 2;

        possiblePairs.push({
          mentor,
          mentee,
          mentorScore,
          menteeScore,
          mutualScore,
          mentorReasoning: mentorPreference.reasoning,
          menteeReasoning: menteePreference.reasoning
        });
      }
    }

    // STEP 4: Select the strongest mutual pairs.

    possiblePairs.sort((a, b) =>
      b.mutualScore - a.mutualScore
    );

    console.log(
      'Mutually suitable pairs:',
      possiblePairs.length
    );

    const matchedIds = new Set();
    let created = 0;

    for (const pair of possiblePairs) {
      const {
        mentor,
        mentee,
        mentorScore,
        menteeScore,
        mutualScore
      } = pair;

      if (matchedIds.has(String(mentor.id))) continue;
      if (matchedIds.has(String(mentee.id))) continue;

      const matchId = randomId();

      try {
        const result = await DB.prepare(`
          INSERT INTO matches (
            id,
            mentor_id,
            mentee_id,
            status
          )
          SELECT ?, ?, ?, 'pending'
          WHERE
            (SELECT match_status
             FROM personality_profiles
             WHERE id = ?) = 'unmatched'
          AND
            (SELECT match_status
             FROM personality_profiles
             WHERE id = ?) = 'unmatched'
        `).bind(
          matchId,
          mentor.id,
          mentee.id,
          mentor.id,
          mentee.id
        ).run();

        if (result.meta?.changes !== 1) continue;

        await DB.prepare(`
          UPDATE personality_profiles
          SET match_status = 'pending',
              updated_at = CURRENT_TIMESTAMP
          WHERE id IN (?, ?)
            AND match_status = 'unmatched'
        `).bind(
          mentor.id,
          mentee.id
        ).run();

        matchedIds.add(String(mentor.id));
        matchedIds.add(String(mentee.id));

        created++;

        console.log('========== MATCH CREATED ==========');

        console.log({
          matchId,
          mentor: mentor.full_name,
          mentee: mentee.full_name,
          mentorPreference: mentorScore,
          menteePreference: menteeScore,
          mutualCompatibility: mutualScore,
          mentorReasoning: pair.mentorReasoning,
          menteeReasoning: pair.menteeReasoning
        });

      } catch (error) {
        console.error('MATCH CREATION ERROR:', error);
      }
    }

    console.log('========== MATCHING COMPLETE ==========');

    return {
      created,
      evaluatedMentors: mentorRankings.size,
      evaluatedMentees: menteeRankings.size,
      compatiblePairs: possiblePairs.length
    };

  } catch (error) {
    console.error(
      'MATCHING ENGINE ERROR:',
      error?.stack || error?.message || error
    );

    return {
      created: 0,
      error: error?.message || 'Matching engine failed.'
    };
  }
}

// =============================================
// CURRENT RANKINGS API
// =============================================

async function getCurrentRankings(DB) {
  const { results } = await DB.prepare(`
    SELECT
      cr.evaluator_id,
      cr.ranking_json,
      cr.updated_at,
      evaluator.full_name AS evaluator_name,
      evaluator.role AS evaluator_role
    FROM candidate_rankings cr
    JOIN personality_profiles evaluator
      ON evaluator.id = cr.evaluator_id
    ORDER BY evaluator.role, evaluator.full_name
  `).all();

  const rankings = [];

  for (const row of results || []) {
    const rankingData = parseJSON(row.ranking_json, {});

    const candidateIds = Object.keys(rankingData).filter(
      id => rankingData[id] &&
        typeof rankingData[id] === 'object'
    );

    if (!candidateIds.length) continue;

    const candidateMap = new Map();

    // Chunk lookups to avoid SQLite/D1 parameter limits.
    for (let i = 0; i < candidateIds.length; i += 80) {
      const chunk = candidateIds.slice(i, i + 80);
      const placeholders = chunk.map(() => '?').join(',');

      const { results: candidates } = await DB.prepare(`
        SELECT id, full_name, role
        FROM personality_profiles
        WHERE id IN (${placeholders})
      `).bind(...chunk).all();

      for (const candidate of candidates || []) {
        candidateMap.set(String(candidate.id), candidate);
      }
    }

    const candidateRankings = candidateIds
      .map(id => {
        const candidate = candidateMap.get(String(id));
        const evaluation = rankingData[id];

        if (!candidate) return null;

        return {
          id: candidate.id,
          name: candidate.full_name || 'Unnamed candidate',
          role: candidate.role,
          score: clampNumber(evaluation.score, 0, 100, 50),
          reasoning: safeString(evaluation.reasoning),
          fallback: evaluation.fallback === true
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    rankings.push({
      evaluatorId: row.evaluator_id,
      evaluator: row.evaluator_name || 'Unnamed evaluator',
      role: row.evaluator_role,
      updatedAt: row.updated_at,
      candidates: candidateRankings
    });
  }

  return rankings;
}

// =============================================
// MATCH ACCEPTANCE / DECLINE
// =============================================

async function handleMatchResponse(request, env, url) {
  const matchId = safeString(url.searchParams.get('matchId'));
  const userId = safeString(url.searchParams.get('user'));
  const action = normalize(url.searchParams.get('action'));

  if (
    !matchId ||
    !userId ||
    !['accept', 'deny'].includes(action)
  ) {
    return new Response('Invalid match response.', {
      status: 400
    });
  }

  const match = await env.DB.prepare(`
    SELECT *
    FROM matches
    WHERE id = ?
  `).bind(matchId).first();

  if (!match) {
    return new Response('Match not found.', {
      status: 404
    });
  }

  const isMentor = match.mentor_id === userId;
  const isMentee = match.mentee_id === userId;

  if (!isMentor && !isMentee) {
    return new Response('Unauthorized match response.', {
      status: 403
    });
  }

  if (['declined', 'accepted'].includes(match.status)) {
    return new Response(
      'This match has already been finalized.',
      { status: 409 }
    );
  }

  if (action === 'deny') {
    await env.DB.prepare(`
      UPDATE matches
      SET status = 'declined',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(matchId).run();

    await env.DB.prepare(`
      UPDATE personality_profiles
      SET match_status = 'unmatched',
          updated_at = CURRENT_TIMESTAMP
      WHERE id IN (?, ?)
    `).bind(match.mentor_id, match.mentee_id).run();

    await runMatchingEngine(env.DB, env.AI);

    return new Response(
      '<h1>Match declined.</h1><p>You may be considered for another match.</p>',
      {
        headers: {
          'Content-Type': 'text/html;charset=UTF-8'
        }
      }
    );
  }

  const otherAlreadyAccepted = isMentor
    ? match.status === 'mentee_accepted'
    : match.status === 'mentor_accepted';

  const newStatus = otherAlreadyAccepted
    ? 'accepted'
    : isMentor
      ? 'mentor_accepted'
      : 'mentee_accepted';

  await env.DB.prepare(`
    UPDATE matches
    SET status = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status IN (
        'pending',
        'mentor_accepted',
        'mentee_accepted'
      )
  `).bind(newStatus, matchId).run();

  if (newStatus === 'accepted') {
    await DBUpdateMatchedProfiles(
      env.DB,
      match.mentor_id,
      match.mentee_id
    );
  }

  return new Response(
    newStatus === 'accepted'
      ? '<h1>Match confirmed!</h1><p>Both participants accepted.</p>'
      : '<h1>Acceptance received!</h1><p>Waiting for the other participant.</p>',
    {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8'
      }
    }
  );
}

async function DBUpdateMatchedProfiles(DB, mentorId, menteeId) {
  await DB.prepare(`
    UPDATE personality_profiles
    SET match_status = 'matched',
        updated_at = CURRENT_TIMESTAMP
    WHERE id IN (?, ?)
  `).bind(mentorId, menteeId).run();
}

// =============================================
// FOLLOW-UP QUESTION GENERATOR
// =============================================

async function generateFollowUp(AI, incoming, responses) {
  const mainQuestion = safeString(
    incoming.mainQuestion || incoming.ogq || ''
  );

  const userSignal = safeString(incoming.signal || '');
  const followUpCount = Number(incoming.followUpCount) || 0;

  if (
    followUpCount >= 1 ||
    mainQuestion.toLowerCase().includes('days of the week')
  ) {
    return {
      moveNext: true,
      followUp: ''
    };
  }

  if (isGibberishOrSpam(userSignal)) {
    return {
      moveNext: true,
      followUp: ''
    };
  }

  const lowerSignal = userSignal.toLowerCase().trim();

  const donePhrases = [
    'done',
    'finish',
    'finished',
    'no',
    'nope',
    'nah',
    'skip',
    'next',
    'move on'
  ];

  if (donePhrases.some(phrase =>
    lowerSignal === phrase ||
    lowerSignal.startsWith(phrase + ' ')
  )) {
    return {
      moveNext: true,
      followUp: ''
    };
  }

  if (!AI) {
    return {
      moveNext: true,
      followUp: ''
    };
  }

  const previousHistory = Object.entries(responses)
    .filter(([key]) => !isPrivateField(key))
    .map(([question, answer]) =>
      `Q: "${question}" | A: "${safeString(answer)}"`
    )
    .join('\n');

  const prompt = `
You are a warm, professional onboarding assistant.

ROLE:
${safeString(getResponseValue(responses, 'Role')) || 'member'}

PREVIOUS ANSWERS:
${previousHistory || 'None'}

CURRENT MAIN QUESTION:
${mainQuestion}

USER ANSWER:
${userSignal}

Return a JSON object:
{
  "follow_up": "question or stop"
}

RULES:
- If the answer is clear, return "stop".
- If vague, ask ONE brief clarifying question.
- The question must have fewer than 12 words.
- Do not ask multiple questions.
- Do not repeat questions already answered.
- If spam, return "stop".
`;

  try {
    const parsed = await runAIJson(AI, prompt, {
      temperature: 0,
      max_tokens: 150
    });

    const nextText = safeString(parsed.follow_up)
      .trim()
      .replace(/^["']|["']$/g, '');

    const wordCount = nextText
      .split(/\s+/)
      .filter(Boolean).length;

    const validQuestion =
      nextText.endsWith('?') &&
      (nextText.match(/\?/g) || []).length === 1 &&
      wordCount < 12 &&
      nextText.toLowerCase() !== 'stop';

    if (!validQuestion) {
      return {
        moveNext: true,
        followUp: ''
      };
    }

    return {
      moveNext: false,
      followUp: nextText
    };

  } catch (error) {
    console.error('FOLLOW-UP ERROR:', error);

    return {
      moveNext: true,
      followUp: ''
    };
  }
}

// =============================================
// MAIN WORKER
// =============================================

export default {
  async scheduled(event, env, ctx) {
    if (!env.DB) return;

    ctx.waitUntil(
      runMatchingEngine(env.DB, env.AI).catch(error => {
        console.error('SCHEDULED MATCHING ERROR:', error);
      })
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Automatic matching on every request.
    // Cached successful rankings prevent unnecessary AI calls.
    if (env.DB) {
      try {
        console.log(
          'FETCH RECEIVED:',
          request.method,
          url.pathname
        );

        await runMatchingEngine(env.DB, env.AI);

      } catch (error) {
        console.error(
          'AUTOMATIC MATCHING ERROR:',
          error
        );
      }
    }

    // =========================================
    // MATCH RESPONSE
    // =========================================

    if (
      url.pathname === '/api/match/response' &&
      request.method === 'GET'
    ) {
      try {
        return await handleMatchResponse(
          request,
          env,
          url
        );

      } catch (error) {
        console.error('MATCH RESPONSE ERROR:', error);

        return new Response(
          'Unable to process match response.',
          { status: 500 }
        );
      }
    }

    // =========================================
    // GET ROUTES
    // =========================================

    if (request.method === 'GET') {
      if (url.pathname === '/api/rankings') {
        if (!env.DB) {
          return jsonResponse({
            success: false,
            error: 'Database binding DB is missing.'
          }, 500);
        }

        try {
          const rankings = await getCurrentRankings(env.DB);

          return jsonResponse({
            success: true,
            rankings
          });

        } catch (error) {
          console.error('RANKINGS ERROR:', error);

          return jsonResponse({
            success: false,
            error: error?.message ||
              'Unable to retrieve rankings.'
          }, 500);
        }
      }

      if (url.pathname === '/api/health') {
        return jsonResponse({
          status: 'ok',
          database: Boolean(env.DB),
          ai: Boolean(env.AI),
          matching: Boolean(env.DB)
        });
      }

      if (url.pathname === '/') {
        return new Response(html, {
          headers: {
            'Content-Type': 'text/html;charset=UTF-8'
          }
        });
      }

      return jsonResponse({
        error: 'Not found.'
      }, 404);
    }

    // =========================================
    // POST ROUTES
    // =========================================

    if (request.method !== 'POST') {
      return new Response('Method not allowed.', {
        status: 405
      });
    }

    try {
      const incoming = await request.json();

      const responses = incoming.responses || {};

      if (!validResponses(responses)) {
        return jsonResponse({
          saved: false,
          error: 'Invalid responses object.'
        }, 400);
      }

      // =======================================
      // COMPLETED ONBOARDING
      // =======================================

      if (incoming.isComplete === true) {
        if (!env.DB) {
          return jsonResponse({
            saved: false,
            error: 'Database binding DB is missing.'
          }, 500);
        }

        const profileId =
          safeString(incoming.submissionId) || randomId();

        // Analyze even if AI is unavailable.
        // analyzePersonality returns a fallback profile.
        const analysis = await analyzePersonality(
          env.AI,
          responses
        );

        // Save the original answers regardless of AI success.
        await saveProfile(
          env.DB,
          responses,
          analysis,
          profileId
        );

        let matching = {
          created: 0
        };

        if (
          analysis.quality_score > 0.1 &&
          ['success', 'fallback'].includes(analysis.status)
        ) {
          matching = await runMatchingEngine(
            env.DB,
            env.AI
          );
        }

        return jsonResponse({
          saved: true,
          profileId,
          qualityScore: analysis.quality_score,
          fitRating: analysis.fit_rating,
          personality: analysis.personality,
          personalitySummary: analysis.summary,
          analysisStatus: analysis.status,
          analysisError: analysis.error,
          matching
        });
      }

      // =======================================
      // INCOMPLETE ONBOARDING / FOLLOW-UP
      // =======================================

      if (!env.AI) {
        return jsonResponse({
          moveNext: true,
          followUp: '',
          error: 'Cloudflare AI binding is unavailable.'
        });
      }

      const conversationResult = await generateFollowUp(
        env.AI,
        incoming,
        responses
      );

      return jsonResponse(conversationResult);

    } catch (error) {
      console.error(
        'REQUEST ERROR:',
        error?.stack || error?.message || error
      );

      return jsonResponse({
        saved: false,
        moveNext: true,
        followUp: '',
        error: error?.message || 'Internal server error.'
      }, 500);
    }
  }
};

