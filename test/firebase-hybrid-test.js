const element = (id) => document.getElementById(id);
const controls = {
  status: element("status"),
  prompt: element("prompt"),
  cloudModel: element("cloud-model"),
  consent: element("cloud-consent"),
  local: element("local"),
  appCheck: element("app-check"),
  cloud: element("cloud"),
  hybrid: element("hybrid"),
  log: element("log"),
  reply: element("reply"),
};

let ready = false;
let busy = false;
let appCheckVerified = false;
let sdk;
let ai;
let appCheck;
const models = new Map();

function log(message) {
  controls.log.textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
}

function updateControls() {
  controls.local.disabled = !ready || busy;
  controls.appCheck.disabled = !ready || busy;
  controls.cloud.disabled = !ready || busy || !appCheckVerified || !controls.consent.checked;
  controls.hybrid.disabled = controls.cloud.disabled;
  controls.prompt.disabled = busy;
  controls.cloudModel.disabled = busy;
  controls.consent.disabled = busy;
}

function revokeConsent() {
  controls.consent.checked = false;
  updateControls();
}

function errorText(error) {
  const code = error?.code || error?.name || "Error";
  const message = String(error?.message || error)
    .replace(/AIza[\w-]+/g, "<REDACTED>")
    .replace(/([?&](?:key|token|debug_token)=)[^&\s]+/gi, "$1<REDACTED>");
  return `${code}: ${message}`;
}

async function run(label, operation) {
  if (!ready || busy) return;
  busy = true;
  updateControls();
  const started = performance.now();
  const notice = setTimeout(() => {
    log(`${label}仍在等待。没有自动重试；请保留这条日志，不要重复点击。`);
  }, 20000);
  try {
    await operation();
    log(`${label}完成，耗时 ${((performance.now() - started) / 1000).toFixed(1)} 秒。`);
  } catch (error) {
    log(`${label}失败，${errorText(error)}`);
  } finally {
    clearTimeout(notice);
    busy = false;
    updateControls();
  }
}

function getModel(mode, cloudModel) {
  const key = `${mode}:${cloudModel}`;
  if (!models.has(key)) {
    models.set(key, sdk.getGenerativeModel(ai, {
      mode,
      inCloudParams: { model: cloudModel },
      onDeviceParams: {
        createOptions: {
          expectedInputs: [{ type: "text" }],
          expectedOutputs: [{ type: "text" }],
        },
      },
    }));
  }
  return models.get(key);
}

async function generate(kind) {
  const text = controls.prompt.value.trim();
  const cloudModel = controls.cloudModel.value.trim();
  if (!text) throw new Error("请先填写提示词。");
  if (!cloudModel) throw new Error("请填写云端模型名称。");
  if (kind !== "local" && (!controls.consent.checked || !appCheckVerified)) {
    throw new Error("请先验证 App Check，并同意当前提示词的云端发送。");
  }

  const mode = {
    local: sdk.InferenceMode.ONLY_ON_DEVICE,
    cloud: sdk.InferenceMode.ONLY_IN_CLOUD,
    hybrid: sdk.InferenceMode.PREFER_ON_DEVICE,
  }[kind];
  const model = getModel(mode, cloudModel);
  controls.reply.textContent = "正在生成。";
  log(`本次模式：${mode}。`);

  if (kind === "local") {
    let lastPercent = -1;
    await model.initializeDeviceModel((progress) => {
      const percent = Math.floor(progress * 100);
      if (percent !== lastPercent && (percent % 5 === 0 || percent === 100)) {
        lastPercent = percent;
        log(`端侧模型准备进度 ${percent}%。`);
      }
    });
  }

  const { response } = await model.generateContent(text);
  const source = response.inferenceSource;
  if (kind === "local" && source !== sdk.InferenceSource.ON_DEVICE) {
    throw new Error(`端侧测试返回了非预期来源：${source}。`);
  }
  if (kind === "cloud" && source !== sdk.InferenceSource.IN_CLOUD) {
    throw new Error(`云端测试返回了非预期来源：${source}。`);
  }
  log(`SDK 返回的实际来源：${source || "未提供"}。`);
  if (kind === "hybrid") {
    log(source === sdk.InferenceSource.ON_DEVICE
      ? "本次端侧优先实际使用了本地模型，尚未验证云端回退。"
      : source === sdk.InferenceSource.IN_CLOUD
        ? "本次端侧优先实际使用了云端模型。"
        : "SDK 未返回来源，不能据此确认执行路径。");
  }
  const reply = response.text();
  if (!reply) throw new Error("请求结束但没有文本回复，请检查模型响应或安全过滤。");
  controls.reply.textContent = reply;
}

controls.prompt.addEventListener("input", revokeConsent);
controls.cloudModel.addEventListener("input", revokeConsent);
controls.consent.addEventListener("change", updateControls);
controls.local.addEventListener("click", () => run("Firebase 端侧测试", () => generate("local")));
controls.cloud.addEventListener("click", () => run("Firebase 云端测试", () => generate("cloud")));
controls.hybrid.addEventListener("click", () => run("Firebase 端侧优先测试", () => generate("hybrid")));
controls.appCheck.addEventListener("click", () => run("App Check 验证", async () => {
  appCheckVerified = false;
  await sdk.getToken(appCheck, true);
  appCheckVerified = true;
  log("已取得官方 App Check 验证令牌，令牌内容不写入页面日志。");
}));

async function initialize() {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    throw new Error("本调试页只允许 localhost 使用，不用于部署。");
  }
  if (!window.isSecureContext) {
    throw new Error("请通过 http://localhost 打开，不能直接打开 HTML 文件。");
  }

  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  const [appModule, aiModule, checkModule, configModule] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/13.4.0/firebase-ai.js"),
    import("https://www.gstatic.com/firebasejs/13.4.0/firebase-app-check.js"),
    import("./firebase-config.local.js"),
  ]);
  sdk = { ...aiModule, getToken: checkModule.getToken };
  const app = appModule.initializeApp(configModule.firebaseConfig);
  appCheck = checkModule.initializeAppCheck(app, {
    // Debug模式走Firebase官方token交换；不允许此提供方退化为生产验证。
    provider: new checkModule.CustomProvider({
      getToken: async () => {
        throw new Error("此页仅支持 App Check debug 模式，发布时需配置生产提供方。");
      },
    }),
    isTokenAutoRefreshEnabled: false,
  });
  ai = sdk.getAI(app, { backend: new sdk.GoogleAIBackend() });
  ready = true;
  controls.status.textContent = `Firebase SDK 已就绪，项目 ${app.options.projectId}。先点“只测端侧”。`;
  log("Firebase SDK 13.4.0 已加载；未调用生成接口，未发送提示词。");
  log("App Check debug token 由 SDK 显示在开发者工具控制台，不用发给助手。");
  updateControls();
}

initialize().catch((error) => {
  controls.status.textContent = "初始化失败，请查看下方日志。";
  log(errorText(error));
  updateControls();
});
