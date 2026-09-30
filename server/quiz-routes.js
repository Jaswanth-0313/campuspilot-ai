import { Router } from 'express'
import { db, randomUUID, requireAuth } from './auth.js'

const router = Router()
const difficulties = new Set(['beginner', 'intermediate', 'advanced'])
router.use(requireAuth)

router.get('/', (req, res) => {
  const quizzes = db.prepare(`SELECT q.id, q.topic, q.difficulty, q.source, q.created_at AS createdAt,
      (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS questionCount,
      (SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.user_id = q.user_id) AS attemptCount,
      (SELECT score FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.user_id = q.user_id ORDER BY completed_at DESC LIMIT 1) AS latestScore,
      (SELECT total FROM quiz_attempts qa WHERE qa.quiz_id = q.id AND qa.user_id = q.user_id ORDER BY completed_at DESC LIMIT 1) AS latestTotal
    FROM quizzes q WHERE q.user_id = ? ORDER BY q.created_at DESC LIMIT 100`).all(req.user.id)
  return res.json({ quizzes })
})

router.post('/', (req, res) => {
  const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : ''
  const difficulty = req.body?.difficulty
  const questions = req.body?.questions
  const source = req.body?.source === 'assemblyai-live' ? 'assemblyai-live' : 'local-sample'
  if (!topic || topic.length > 160 || !difficulties.has(difficulty)) return res.status(400).json({ message: 'Topic or difficulty is invalid.' })
  if (!Array.isArray(questions) || questions.length < 2 || questions.length > 30) return res.status(400).json({ message: 'A quiz must contain 2-30 questions.' })
  for (const question of questions) {
    if (typeof question.prompt !== 'string' || !question.prompt.trim() || question.prompt.length > 1000) return res.status(400).json({ message: 'Each question needs a prompt of up to 1000 characters.' })
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 6 || question.options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 300)) {
      return res.status(400).json({ message: 'Each question needs 2-6 answer options of up to 300 characters.' })
    }
    if (!Number.isInteger(question.answerIndex) || question.answerIndex < 0 || question.answerIndex >= question.options.length) return res.status(400).json({ message: 'Question answer index is invalid.' })
    if (typeof question.explanation !== 'string' || question.explanation.length > 1500) return res.status(400).json({ message: 'Question explanation is invalid.' })
  }

  const id = randomUUID()
  const now = new Date().toISOString()
  const save = db.transaction(() => {
    db.prepare('INSERT INTO quizzes (id, user_id, topic, difficulty, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, req.user.id, topic, difficulty, source, now)
    const addQuestion = db.prepare('INSERT INTO quiz_questions (id, quiz_id, ordinal, prompt, options_json, answer_index, explanation) VALUES (?, ?, ?, ?, ?, ?, ?)')
    questions.forEach((question, ordinal) => addQuestion.run(randomUUID(), id, ordinal, question.prompt.trim(), JSON.stringify(question.options.map((option) => option.trim())), question.answerIndex, question.explanation.trim()))
  })
  save()
  return res.status(201).json({ quiz: { id, topic, difficulty, source, questionCount: questions.length, createdAt: now } })
})

router.get('/:quizId', (req, res) => {
  const quiz = db.prepare(`SELECT id, topic, difficulty, source, created_at AS createdAt FROM quizzes WHERE id = ? AND user_id = ?`).get(req.params.quizId, req.user.id)
  if (!quiz) return res.status(404).json({ message: 'Quiz not found.' })
  const questions = db.prepare(`SELECT id, prompt, options_json AS optionsJson, ordinal FROM quiz_questions WHERE quiz_id = ? ORDER BY ordinal`).all(quiz.id)
    .map(({ optionsJson, ...question }) => ({ ...question, options: JSON.parse(optionsJson) }))
  return res.json({ quiz, questions })
})

router.post('/:quizId/attempts', (req, res) => {
  const quiz = db.prepare('SELECT id, topic FROM quizzes WHERE id = ? AND user_id = ?').get(req.params.quizId, req.user.id)
  if (!quiz) return res.status(404).json({ message: 'Quiz not found.' })
  const questions = db.prepare('SELECT id, prompt, options_json, answer_index, explanation, ordinal FROM quiz_questions WHERE quiz_id = ? ORDER BY ordinal').all(quiz.id)
  const answers = req.body?.answers
  if (!Array.isArray(answers) || answers.length !== questions.length) return res.status(400).json({ message: 'Submit exactly one answer index for every question.' })
  for (let index = 0; index < questions.length; index += 1) {
    const options = JSON.parse(questions[index].options_json)
    if (!Number.isInteger(answers[index]) || answers[index] < 0 || answers[index] >= options.length) return res.status(400).json({ message: `Answer ${index + 1} is invalid.` })
  }
  const score = answers.reduce((total, answer, index) => total + Number(answer === questions[index].answer_index), 0)
  const attemptId = randomUUID()
  const completedAt = new Date().toISOString()
  db.prepare(`INSERT INTO quiz_attempts (id, quiz_id, user_id, score, total, answers_json, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(attemptId, quiz.id, req.user.id, score, questions.length, JSON.stringify(answers), completedAt)
  const results = questions.map((question, index) => ({
    prompt: question.prompt,
    options: JSON.parse(question.options_json),
    selectedIndex: answers[index],
    correctIndex: question.answer_index,
    correct: answers[index] === question.answer_index,
    explanation: question.explanation,
  }))
  return res.status(201).json({ attempt: { id: attemptId, quizId: quiz.id, score, total: questions.length, completedAt, results } })
})

router.get('/:quizId/attempts', (req, res) => {
  const ownsQuiz = db.prepare('SELECT 1 FROM quizzes WHERE id = ? AND user_id = ?').get(req.params.quizId, req.user.id)
  if (!ownsQuiz) return res.status(404).json({ message: 'Quiz not found.' })
  const attempts = db.prepare(`SELECT id, score, total, completed_at AS completedAt FROM quiz_attempts
    WHERE quiz_id = ? AND user_id = ? ORDER BY completed_at DESC LIMIT 100`).all(req.params.quizId, req.user.id)
  return res.json({ attempts })
})

export default router