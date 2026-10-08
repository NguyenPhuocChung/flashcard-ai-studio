const { app, BrowserWindow, ipcMain } = require("electron");
app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess");
app.commandLine.appendSwitch("disable-features", "OutOfBlinkCors");
const { autoUpdater } = require("electron-updater");
const log = require("electron-log");

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = "info";
const path = require("path");
const fs = require("fs");
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");

let mainWindow = null;

// ============================================================
// CONFIG
// ============================================================

const APP_NAME = "Flashcard AI";

const DATA_FILE = path.join(
  app.getPath("userData"),
  "flashcards_data.json"
);

const TEMP_DATA_FILE = `${DATA_FILE}.tmp`;

// Timeout cho mỗi lần gọi Gemini
const AI_TIMEOUT_MS = 15000;

// Chỉ cho phép tạo tối đa 30 thẻ/lần
const MAX_CARDS_PER_REQUEST = 30;

// Model ưu tiên.
// 3.5 Flash-Lite phù hợp cho tác vụ tạo dữ liệu nhẹ,
// structured output và tốc độ cao.
const CANDIDATE_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash"
];

// ============================================================
// WINDOW
// ============================================================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 600,

    title: APP_NAME,

    icon: path.join(__dirname, "logo_english.png"),

    backgroundColor: "#f6f7fb",

    webPreferences: {
      // Giữ tương thích với index.html hiện tại
      nodeIntegration: true,
      contextIsolation: false
    }

  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (permission === "media") {
        callback(true);
      } else {
        callback(false);
      }
    }
  );
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ============================================================
// APP LIFECYCLE
// ============================================================

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // Đăng ký sự kiện update
  autoUpdater.on("update-available", () => {
    log.info("Có bản cập nhật mới, đang tải...");
  });

  autoUpdater.on("update-downloaded", () => {
    const { dialog } = require("electron");
    dialog
      .showMessageBox({
        type: "info",
        title: "Cập nhật sẵn sàng",
        message: "Đã tải xong bản cập nhật. Khởi động lại để áp dụng?",
        buttons: ["Khởi động lại ngay", "Để sau"],
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  // Chỉ kiểm tra update khi app đã được đóng gói (không check lúc dev)
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// ============================================================
// HELPER: ENSURE DATA DIRECTORY
// ============================================================

function ensureDataDirectory() {
  try {
    const userDataPath = app.getPath("userData");

    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, {
        recursive: true
      });
    }

    return true;
  } catch (error) {
    console.error(
      "[DATA] Không thể tạo thư mục dữ liệu:",
      error.message
    );

    return false;
  }
}

// ============================================================
// HELPER: NORMALIZE APP DATA
// ============================================================

function normalizeAppData(data) {
  if (!data || typeof data !== "object") {
    return {
      topics: []
    };
  }

  if (!Array.isArray(data.topics)) {
    data.topics = [];
  }

  data.topics = data.topics
    .filter((topic) => topic && typeof topic === "object")
    .map((topic) => {
      if (!Array.isArray(topic.cards)) {
        topic.cards = [];
      }

      if (!topic.topic_name) {
        topic.topic_name = "Untitled";
      }

      if (!topic.topic_id) {
        topic.topic_id = createId();
      }

      topic.cards = topic.cards
        .filter((card) => card && typeof card === "object")
        .map(normalizeCard);

      return topic;
    });

  return data;
}

// ============================================================
// LEARNING: DEFAULT STATE + HELPERS
// ============================================================

function createDefaultLearning() {
  return {
    status: "unknown",
    correctCount: 0,
    wrongCount: 0,
    pronunciationCorrect: 0,
    pronunciationAttempts: 0,
    lastPronunciationScore: null,
    lastReviewedAt: null,
    nextReviewAt: null,
    reviewLevel: 0,
    consecutiveCorrect: 0,
    totalReviews: 0
  };
}

function normalizeLearning(learning) {
  const value = learning && typeof learning === "object" ? learning : {};

  return {
    status: value.status === "known" ? "known" : "unknown",
    correctCount: Math.max(0, Number(value.correctCount) || 0),
    wrongCount: Math.max(0, Number(value.wrongCount) || 0),
    pronunciationCorrect: Math.max(0, Number(value.pronunciationCorrect) || 0),
    pronunciationAttempts: Math.max(0, Number(value.pronunciationAttempts) || 0),
    lastPronunciationScore:
      value.lastPronunciationScore === null ||
        value.lastPronunciationScore === undefined ||
        Number.isNaN(Number(value.lastPronunciationScore))
        ? null
        : Math.max(0, Math.min(100, Number(value.lastPronunciationScore))),
    lastReviewedAt: value.lastReviewedAt || null,
    nextReviewAt: value.nextReviewAt || null,
    reviewLevel: Math.max(0, Math.min(6, Number(value.reviewLevel) || 0)),
    consecutiveCorrect: Math.max(0, Number(value.consecutiveCorrect) || 0),
    totalReviews: Math.max(0, Number(value.totalReviews) || 0)
  };
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getReviewInterval(level, known) {
  if (!known) return 0;
  const intervals = [0, 1, 3, 7, 14, 30, 60];
  const safeLevel = Math.max(1, Math.min(6, Number(level) || 1));
  return intervals[safeLevel] || 60;
}

function applyReviewResult(card, known) {
  const learning = normalizeLearning(card.learning);
  const now = new Date();

  learning.totalReviews += 1;
  learning.lastReviewedAt = now.toISOString();

  if (known) {
    learning.status = "known";
    learning.correctCount += 1;
    learning.consecutiveCorrect += 1;
    learning.reviewLevel = Math.min(6, learning.reviewLevel + 1);
  } else {
    learning.status = "unknown";
    learning.wrongCount += 1;
    learning.consecutiveCorrect = 0;
    learning.reviewLevel = Math.max(0, learning.reviewLevel - 1);
  }

  const interval = getReviewInterval(learning.reviewLevel, known);
  learning.nextReviewAt = addDays(now, interval).toISOString();

  card.learning = learning;
  return card;
}

function calculateSimilarity(expected, actual) {
  const a = normalizeWord(expected);
  const b = normalizeWord(actual);

  if (!a || !b) return 0;
  if (a === b) return 100;

  const matrix = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  const distance = matrix[a.length][b.length];
  return Math.max(
    0,
    Math.round((1 - distance / Math.max(a.length, b.length)) * 100)
  );
}

function saveAppDataInternal(data) {
  ensureDataDirectory();

  const normalizedData = normalizeAppData(
    JSON.parse(JSON.stringify(data || { topics: [] }))
  );

  fs.writeFileSync(
    TEMP_DATA_FILE,
    JSON.stringify(normalizedData, null, 2),
    "utf-8"
  );

  fs.renameSync(TEMP_DATA_FILE, DATA_FILE);
  return normalizedData;
}

function updateCardById(cardId, updater) {
  ensureDataDirectory();

  let data = { topics: [] };

  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    data = raw.trim() ? JSON.parse(raw) : { topics: [] };
  }

  data = normalizeAppData(data);

  let updatedCard = null;

  for (const topic of data.topics) {
    if (!Array.isArray(topic.cards)) continue;

    const index = topic.cards.findIndex(
      (card) => String(card.id) === String(cardId)
    );

    if (index === -1) continue;

    topic.cards[index] = normalizeCard(
      updater(topic.cards[index])
    );

    updatedCard = topic.cards[index];
    break;
  }

  if (!updatedCard) {
    throw new Error("Không tìm thấy flashcard.");
  }

  saveAppDataInternal(data);
  return updatedCard;
}

// ============================================================
// HELPER: NORMALIZE CARD
// ============================================================

function normalizeCard(card) {
  return {
    id: String(card.id || createId()),

    word: cleanText(card.word),

    phonetic: cleanText(card.phonetic),

    type: cleanText(card.type),

    definition_vi: cleanText(card.definition_vi),

    example_en: cleanText(card.example_en),

    example_vi: cleanText(card.example_vi),

    learning: normalizeLearning(card.learning)
  };
}

// ============================================================
// HELPER: TEXT CLEANING
// ============================================================

function cleanText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value)
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// HELPER: ID
// ============================================================

function createId() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
}

// ============================================================
// HELPER: NORMALIZE WORD FOR COMPARISON
// ============================================================

function normalizeWord(word) {
  return cleanText(word)
    .toLowerCase()
    .replace(/[.,!?;:"'`()\[\]{}]/g, "")
    .replace(/\s+/g, " ");
}

// ============================================================
// 1. LOAD LOCAL DATA
// ============================================================

ipcMain.handle("load-local-data", async () => {
  try {
    ensureDataDirectory();

    if (!fs.existsSync(DATA_FILE)) {
      return {
        topics: []
      };
    }

    const rawData = fs.readFileSync(DATA_FILE, "utf-8");

    if (!rawData.trim()) {
      return {
        topics: []
      };
    }

    const parsedData = JSON.parse(rawData);

    return normalizeAppData(parsedData);
  } catch (error) {
    console.error(
      "[DATA] Lỗi đọc dữ liệu:",
      error.message
    );

    // Không để app crash nếu JSON bị hỏng
    return {
      topics: []
    };
  }
});

// ============================================================
// 2. SAVE LOCAL DATA
// ============================================================

ipcMain.handle("save-local-data", async (event, data) => {
  try {
    if (!ensureDataDirectory()) {
      return {
        success: false,
        error: "Không thể tạo thư mục dữ liệu của ứng dụng."
      };
    }

    const normalizedData = normalizeAppData(
      JSON.parse(JSON.stringify(data || { topics: [] }))
    );

    const json = JSON.stringify(
      normalizedData,
      null,
      2
    );

    // Ghi file tạm trước
    // tránh trường hợp app bị tắt giữa lúc đang ghi
    fs.writeFileSync(
      TEMP_DATA_FILE,
      json,
      "utf-8"
    );

    // Sau đó thay thế file chính
    fs.renameSync(
      TEMP_DATA_FILE,
      DATA_FILE
    );

    return {
      success: true
    };
  } catch (error) {
    console.error(
      "[DATA] Lỗi lưu dữ liệu:",
      error.message
    );

    // Dọn file tạm nếu có
    try {
      if (fs.existsSync(TEMP_DATA_FILE)) {
        fs.unlinkSync(TEMP_DATA_FILE);
      }
    } catch (_) { }

    return {
      success: false,
      error: error.message
    };
  }
});

// ============================================================
// 3. GEMINI SCHEMA
// ============================================================

const flashcardSchema = {
  type: SchemaType.OBJECT,

  properties: {
    topic_id: {
      type: SchemaType.STRING
    },

    topic_name: {
      type: SchemaType.STRING
    },

    cards: {
      type: SchemaType.ARRAY,

      items: {
        type: SchemaType.OBJECT,

        properties: {
          id: {
            type: SchemaType.STRING
          },

          word: {
            type: SchemaType.STRING
          },

          phonetic: {
            type: SchemaType.STRING
          },

          type: {
            type: SchemaType.STRING
          },

          definition_vi: {
            type: SchemaType.STRING
          },

          example_en: {
            type: SchemaType.STRING
          },

          example_vi: {
            type: SchemaType.STRING
          }
        },

        required: [
          "id",
          "word",
          "phonetic",
          "type",
          "definition_vi",
          "example_en",
          "example_vi"
        ]
      }
    }
  },

  required: [
    "topic_id",
    "topic_name",
    "cards"
  ]
};

// ============================================================
// 4. TIMEOUT
// ============================================================

function withTimeout(promise, timeoutMs) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `AI_TIMEOUT:${timeoutMs}`
        )
      );
    }, timeoutMs);
  });

  return Promise.race([
    promise,
    timeoutPromise
  ]).finally(() => {
    clearTimeout(timeoutId);
  });
}

// ============================================================
// 5. BUILD PROMPT
// ============================================================

function buildPrompt({
  topic,
  existingWords,
  count
}) {
  const existingList = Array.isArray(existingWords)
    ? existingWords
      .map(normalizeWord)
      .filter(Boolean)
      .slice(0, 500)
    : [];

  let prompt = `
Bạn là chuyên gia xây dựng nội dung học từ vựng tiếng Anh.

Hãy tạo ${count} từ vựng tiếng Anh hữu ích cho chủ đề:

"${topic}"

MỤC TIÊU:
- Từ vựng phải thực tế và có giá trị học tập.
- Phù hợp với chủ đề.
- Ưu tiên từ thường gặp trong giao tiếp hoặc trong ngữ cảnh thực tế.
- Không tạo các từ quá hiếm nếu không cần thiết.
- Không tạo từ trùng nghĩa một cách vô ích.
- Mỗi từ phải có ví dụ tiếng Anh tự nhiên.
- Ví dụ phải thể hiện đúng nghĩa của từ.
- Nghĩa tiếng Việt phải ngắn gọn, chính xác.
- Phiên âm nên dùng IPA chuẩn.
- "type" là từ loại, ví dụ: noun, verb, adjective, adverb, phrase.
- Chỉ trả về JSON đúng theo schema.
`;

  if (existingList.length > 0) {
    prompt += `

CÁC TỪ ĐÃ CÓ:
${JSON.stringify(existingList)}

QUY TẮC QUAN TRỌNG:
- Không được tạo bất kỳ từ nào trùng với danh sách trên.
- Không chỉ thay đổi chữ hoa/chữ thường để tạo thành một từ mới.
- Không tạo biến thể số nhiều nếu từ gốc đã tồn tại, trừ khi thực sự cần thiết.
`;
  }

  prompt += `

Hãy kiểm tra lại danh sách trước khi trả kết quả.
Số lượng card phải đúng là ${count}.
`;

  return prompt;
}

// ============================================================
// 6. VALIDATE GEMINI RESULT
// ============================================================

function validateGeneratedData(data, topic, requestedCount) {
  if (!data || typeof data !== "object") {
    throw new Error(
      "AI trả về dữ liệu không hợp lệ."
    );
  }

  if (!Array.isArray(data.cards)) {
    throw new Error(
      "AI không trả về danh sách flashcard."
    );
  }

  const cleanedCards = [];

  const seen = new Set();

  for (const rawCard of data.cards) {
    if (!rawCard || typeof rawCard !== "object") {
      continue;
    }

    const card = normalizeCard(rawCard);

    if (!card.word) continue;
    if (!card.definition_vi) continue;
    if (!card.example_en) continue;

    const normalized = normalizeWord(
      card.word
    );

    if (!normalized) continue;

    // Không trùng trong chính response
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);

    // ID luôn do app quản lý
    card.id = createId();

    cleanedCards.push(card);

    if (
      cleanedCards.length >=
      requestedCount
    ) {
      break;
    }
  }

  if (cleanedCards.length === 0) {
    throw new Error(
      "AI không tạo được flashcard hợp lệ."
    );
  }

  return {
    topic_id:
      cleanText(data.topic_id) ||
      createId(),

    topic_name:
      cleanText(data.topic_name) ||
      topic,

    cards: cleanedCards
  };
}

// ============================================================
// 7. FRIENDLY ERROR
// ============================================================

function getFriendlyAIError(error) {
  const message =
    error?.message ||
    String(error || "");

  const lower =
    message.toLowerCase();

  if (
    lower.includes("api key") ||
    lower.includes("apikey") ||
    lower.includes("unauthorized") ||
    lower.includes("401") ||
    lower.includes("permission denied")
  ) {
    return "API Key không hợp lệ hoặc chưa được cấp quyền sử dụng Gemini.";
  }

  if (
    lower.includes("quota") ||
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("resource exhausted")
  ) {
    return "API đang hết hạn mức hoặc bị giới hạn tốc độ. Hãy thử lại sau.";
  }

  if (
    lower.includes("timeout") ||
    lower.includes("ai_timeout")
  ) {
    return "AI phản hồi quá chậm. Hãy thử lại hoặc thử chủ đề ngắn hơn.";
  }

  if (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("socket") ||
    lower.includes("enotfound") ||
    lower.includes("econn")
  ) {
    return "Không thể kết nối Gemini. Hãy kiểm tra Internet.";
  }

  if (
    lower.includes("not found") ||
    lower.includes("model")
  ) {
    return "Model Gemini hiện tại không khả dụng với API Key này.";
  }

  return message || "Không xác định được lỗi.";
}

// ============================================================
// 8. LEARNING: REVIEW / PRONUNCIATION / STATS
// ============================================================

ipcMain.handle("mark-card-status", async (event, { cardId, known } = {}) => {
  try {
    if (!cardId) {
      return { success: false, error: "Thiếu cardId." };
    }

    const updatedCard = updateCardById(cardId, (card) =>
      applyReviewResult(card, Boolean(known))
    );

    return { success: true, card: updatedCard };
  } catch (error) {
    console.error("[LEARNING] Lỗi cập nhật trạng thái:", error);
    return {
      success: false,
      error: error.message || "Không thể cập nhật trạng thái."
    };
  }
});

ipcMain.handle(
  "submit-pronunciation",
  async (event, { cardId, transcript } = {}) => {
    try {
      if (!cardId) {
        return { success: false, error: "Thiếu cardId." };
      }

      const actual = cleanText(transcript);
      if (!actual) {
        return {
          success: false,
          error: "Không nhận diện được câu trả lời."
        };
      }

      let result = null;

      const updatedCard = updateCardById(cardId, (card) => {
        const learning = normalizeLearning(card.learning);
        const score = calculateSimilarity(card.word, actual);

        learning.pronunciationAttempts += 1;
        learning.lastPronunciationScore = score;

        if (score >= 80) {
          learning.pronunciationCorrect += 1;
        }

        result = {
          score,
          correct: score >= 80,
          expected: card.word,
          transcript: actual
        };

        card.learning = learning;
        return card;
      });

      return { success: true, result, card: updatedCard };
    } catch (error) {
      console.error("[LEARNING] Lỗi chấm phát âm:", error);
      return {
        success: false,
        error: error.message || "Không thể chấm phát âm."
      };
    }
  }
);

ipcMain.handle("get-learning-stats", async () => {
  try {
    const data = fs.existsSync(DATA_FILE)
      ? normalizeAppData(
        JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"))
      )
      : { topics: [] };

    const cards = data.topics.flatMap((topic) =>
      Array.isArray(topic.cards) ? topic.cards : []
    );

    const now = Date.now();

    const dueCards = cards.filter((card) => {
      const learning = normalizeLearning(card.learning);
      if (!learning.nextReviewAt) return true;

      const next = new Date(learning.nextReviewAt).getTime();
      return Number.isNaN(next) || next <= now;
    });

    const weakCards = cards.filter((card) => {
      const learning = normalizeLearning(card.learning);
      const total = learning.correctCount + learning.wrongCount;

      if (learning.status === "unknown") return true;
      if (total === 0) return false;

      return learning.correctCount / total < 0.7;
    });

    const knownCards = cards.filter(
      (card) => normalizeLearning(card.learning).status === "known"
    );

    const pronunciationAttempts = cards.reduce(
      (sum, card) =>
        sum + normalizeLearning(card.learning).pronunciationAttempts,
      0
    );

    const pronunciationCorrect = cards.reduce(
      (sum, card) =>
        sum + normalizeLearning(card.learning).pronunciationCorrect,
      0
    );

    const reviewCorrect = cards.reduce(
      (sum, card) =>
        sum + normalizeLearning(card.learning).correctCount,
      0
    );

    const reviewWrong = cards.reduce(
      (sum, card) =>
        sum + normalizeLearning(card.learning).wrongCount,
      0
    );

    const total = cards.length;

    return {
      success: true,
      stats: {
        total,
        known: knownCards.length,
        weak: weakCards.length,
        due: dueCards.length,
        progress:
          total > 0
            ? Math.round((knownCards.length / total) * 100)
            : 0,
        reviewAccuracy:
          reviewCorrect + reviewWrong > 0
            ? Math.round(
              (reviewCorrect / (reviewCorrect + reviewWrong)) * 100
            )
            : 0,
        pronunciationAccuracy:
          pronunciationAttempts > 0
            ? Math.round(
              (pronunciationCorrect / pronunciationAttempts) * 100
            )
            : 0,
        dueCards,
        weakCards
      }
    };
  } catch (error) {
    console.error("[LEARNING] Lỗi thống kê:", error);
    return {
      success: false,
      error: error.message || "Không thể lấy thống kê học tập."
    };
  }
});


// ============================================================
// 9. GENERATE CARDS
// ============================================================


ipcMain.handle(
  "generate-cards",
  async (
    event,
    {
      apiKey,
      topic,
      existingWords,
      count = 5
    } = {}
  ) => {
    // --------------------------------------------------------
    // Validate input
    // --------------------------------------------------------

    apiKey = cleanText(apiKey);
    topic = cleanText(topic);

    if (!apiKey) {
      return {
        success: false,
        error: "Vui lòng nhập Gemini API Key."
      };
    }

    if (!topic) {
      return {
        success: false,
        error: "Vui lòng nhập chủ đề."
      };
    }

    // Không cho tạo quá nhiều trong một request
    const safeCount = Math.min(
      Math.max(
        Number(count) || 5,
        1
      ),
      MAX_CARDS_PER_REQUEST
    );

    // --------------------------------------------------------
    // Existing words
    // --------------------------------------------------------

    const normalizedExistingWords =
      Array.isArray(existingWords)
        ? existingWords
          .map(normalizeWord)
          .filter(Boolean)
        : [];

    const existingSet =
      new Set(
        normalizedExistingWords
      );

    // --------------------------------------------------------
    // Gemini
    // --------------------------------------------------------

    const genAI =
      new GoogleGenerativeAI(apiKey);

    let lastError = null;

    for (
      const modelName of CANDIDATE_MODELS
    ) {
      try {
        console.log(
          `[Gemini AI] Thử model: ${modelName}`
        );

        const model =
          genAI.getGenerativeModel({
            model: modelName,

            generationConfig: {
              responseMimeType:
                "application/json",

              responseSchema:
                flashcardSchema,

              temperature: 0.25,

              // Giới hạn output để tránh response quá lớn
              maxOutputTokens: 4096
            }
          });

        const prompt =
          buildPrompt({
            topic,
            existingWords:
              normalizedExistingWords,
            count: safeCount
          });

        // ----------------------------------------------------
        // Call Gemini with timeout
        // ----------------------------------------------------

        const result =
          await withTimeout(
            model.generateContent(
              prompt
            ),
            AI_TIMEOUT_MS
          );

        const text =
          result?.response?.text?.();

        if (!text) {
          throw new Error(
            "Gemini trả về nội dung rỗng."
          );
        }

        // ----------------------------------------------------
        // Parse JSON
        // ----------------------------------------------------

        let parsed;

        try {
          parsed =
            JSON.parse(text);
        } catch (jsonError) {
          console.warn(
            "[Gemini AI] JSON không hợp lệ:",
            text.slice(0, 500)
          );

          throw new Error(
            "AI trả về JSON không hợp lệ."
          );
        }

        // ----------------------------------------------------
        // Validate + clean
        // ----------------------------------------------------

        const cleanedData =
          validateGeneratedData(
            parsed,
            topic,
            safeCount
          );

        // ----------------------------------------------------
        // Remove duplicates against existing data
        // ----------------------------------------------------

        cleanedData.cards =
          cleanedData.cards.filter(
            (card) => {
              const normalized =
                normalizeWord(
                  card.word
                );

              return !existingSet.has(
                normalized
              );
            }
          );

        // ----------------------------------------------------
        // Nếu AI vẫn trả trùng hết
        // ----------------------------------------------------

        if (
          cleanedData.cards.length === 0
        ) {
          throw new Error(
            "AI chỉ trả về các từ đã tồn tại. Hãy thử chủ đề cụ thể hơn."
          );
        }

        // ----------------------------------------------------
        // Ensure topic
        // ----------------------------------------------------

        cleanedData.topic_name =
          topic;

        cleanedData.topic_id =
          createId();

        console.log(
          `[Gemini AI] Thành công: ${modelName} → ${cleanedData.cards.length} cards`
        );

        return {
          success: true,
          data: cleanedData,
          model: modelName
        };
      } catch (error) {
        lastError = error;

        console.warn(
          `[Gemini AI] ${modelName} thất bại:`,
          error?.message || error
        );

        // Thử model tiếp theo
      }
    }

    // --------------------------------------------------------
    // All models failed
    // --------------------------------------------------------

    return {
      success: false,
      error: getFriendlyAIError(
        lastError
      )
    };
  }
);