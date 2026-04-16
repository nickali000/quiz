const fs = require("fs");
const path = require("path");

const QUIZ_FILE = path.join(__dirname, "..", "quiz_estratti.json");
const FOOTER_PATTERN = /Powered by TCPDF/i;

function buildKey(question) {
  const subject = typeof question.materia === "string" && question.materia.trim() !== ""
    ? question.materia.trim()
    : "Scienza degli alimenti";
  return `${subject}|${question.pagina}|${question.numero}`;
}

function joinParts(...parts) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

const FIXES = {
  "Scienza degli alimenti|7|11": {
    answerGroups: [[0], [1, 2], [3], [4]],
    correctAnswerIndex: 2
  },
  "Scienza degli alimenti|11|15": {
    answerGroups: [[0], [1, 2], [3], [4]],
    correctAnswerIndex: 1
  },
  "Scienza degli alimenti|16|03": {
    answerGroups: [[0], [1], [2, 3], [4]],
    correctAnswerIndex: 2
  },
  "Scienza degli alimenti|16|04": {
    answerGroups: [[0, 1], [2, 3], [4], [5]],
    correctAnswerIndex: 1
  },
  "Scienza degli alimenti|20|01": {
    answerGroups: [[0, 1], [2], [3, 4], [5, 6]],
    correctAnswerIndex: 2
  },
  "Scienza degli alimenti|20|02": {
    answerGroups: [[0], [1, 2], [3, 4], [5, 6]],
    correctAnswerIndex: 3
  },
  "Scienza degli alimenti|20|03": {
    answerGroups: [[0], [1], [2, 3], [4]],
    correctAnswerIndex: 2
  },
  "Scienza degli alimenti|20|06": {
    answerGroups: [[0, 1], [2], [3, 4], [5, 6]],
    correctAnswerIndex: 2
  },
  "Scienza degli alimenti|24|19": {
    answerGroups: [[0, 1], [2], [3], [4]],
    correctAnswerIndex: 0
  },
  "Scienza degli alimenti|55|16": {
    answerGroups: [[0], [1], [2], [3, 4]],
    correctAnswerIndex: 3
  },
  "Scienza degli alimenti|65|02": {
    answerGroups: [[0, 1], [2, 3], [4, 5], [6, 7]],
    correctAnswerIndex: 1
  },
  "Scienza degli alimenti|66|04": {
    answerGroups: [[0], [1], [2], [3, 4]],
    correctAnswerIndex: 2
  },
  "Scienza degli alimenti|66|05": {
    answerGroups: [[0], [1], [2, 3], [4]],
    correctAnswerIndex: 3
  },
  "Scienza degli alimenti|68|04": {
    answerGroups: [[0], [1, 2], [3, 4], [5]],
    correctAnswerIndex: 1
  },
  "Scienza degli alimenti|84|03": {
    answerGroups: [[0], [1, 2], [3], [4, 5]],
    correctAnswerIndex: 1
  },
  "Scienza degli alimenti|84|04": {
    answerGroups: [[0, 1], [2], [3], [4, 5]],
    correctAnswerIndex: 3
  },
  "Scienza degli alimenti|84|05": {
    answerGroups: [[0], [1, 2], [3, 4], [5]],
    correctAnswerIndex: 0
  },
  "Scienza degli alimenti|84|06": {
    answerGroups: [[0], [1, 2], [3], [4, 5]],
    correctAnswerIndex: 0
  },
  "Scienza degli alimenti|87|02": {
    answerGroups: [[0], [1, 2], [3], [4]],
    correctAnswerIndex: 1
  },
  "Scienza degli alimenti|87|05": {
    answerGroups: [[0], [1, 2], [3], [4]],
    correctAnswerIndex: 1
  },
  "Immunologia|98|05": {
    answerGroups: [[0], [1], [2], [3]]
  }
};

function normalizeAnswers(answers) {
  return answers
    .filter((answer) => typeof answer === "string")
    .map((answer) => answer.trim())
    .filter((answer) => answer !== "" && !FOOTER_PATTERN.test(answer));
}

function applyFix(question, fix) {
  const answers = normalizeAnswers(question.risposte || []);
  const repairedAnswers = fix.answerGroups.map((group) =>
    joinParts(...group.map((index) => answers[index]))
  );

  if (repairedAnswers.some((answer) => answer === "")) {
    throw new Error(`Riparazione fallita per ${buildKey(question)}: gruppo vuoto.`);
  }

  question.risposte = repairedAnswers;

  if (Number.isInteger(fix.correctAnswerIndex)) {
    question.risposta_corretta_index = fix.correctAnswerIndex;
    question.risposta_corretta = repairedAnswers[fix.correctAnswerIndex];
  }
}

function main() {
  const raw = fs.readFileSync(QUIZ_FILE, "utf8");
  const quiz = JSON.parse(raw);
  let repairedCount = 0;

  for (const question of quiz) {
    const key = buildKey(question);
    const fix = FIXES[key];
    if (!fix) {
      if (Array.isArray(question.risposte)) {
        question.risposte = normalizeAnswers(question.risposte);
      }
      continue;
    }

    applyFix(question, fix);
    repairedCount += 1;
  }

  fs.writeFileSync(QUIZ_FILE, `${JSON.stringify(quiz, null, 4)}\n`, "utf8");

  const remainingBroken = quiz.filter(
    (question) => Array.isArray(question.risposte) && question.risposte.length > 4
  );

  console.log(`Riparate ${repairedCount} domande con risposte spezzate.`);
  console.log(`Domande con più di 4 risposte rimaste: ${remainingBroken.length}`);
}

main();
