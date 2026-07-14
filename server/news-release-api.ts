import axios from "axios";
import { Router } from "express";
import { getFrontMindCredentials, toUpstreamAgentProfile } from "./upstream-config";
import { recordUpstreamResource } from "./auth-service";

const router = Router();

interface NewsReleaseAttachment {
  file_id?: string;
  fileId?: string;
  filename?: string;
  name?: string;
}

interface NewsReleaseStartRequest {
  companyName?: string;
  operatorNotes?: string;
  agentProfile?: string;
  attachments?: NewsReleaseAttachment[];
}

function sanitizeFilename(value: string, fallback: string) {
  const safe = String(value || "")
    .replace(/[\\/\0]/g, "_")
    .replace(/^\.+$/, "")
    .trim()
    .slice(0, 160);
  return safe || fallback;
}

function normalizeUserAttachments(attachments: NewsReleaseAttachment[] | undefined) {
  return (attachments || [])
    .map((attachment) => {
      const fileId = attachment.file_id || attachment.fileId || "";
      const filename = sanitizeFilename(
        attachment.filename || attachment.name || "user_material",
        "user_material"
      );
      return fileId ? { file_id: fileId, filename } : null;
    })
    .filter(Boolean) as Array<{ file_id: string; filename: string }>;
}

function buildNewsReleasePrompt(companyName: string, operatorNotes: string) {
  const template = `你是一名资深企业新闻发布会策划人、财经科技媒体主编、品牌战略顾问、事实核查编辑和视觉创意总监。请围绕生成一份可用于正式对外发布的高端新闻发布会图文稿件，最终输出为 Markdown 格式。

## 一、基础信息

企业名称：{企业名称}
发布主题：{发布主题/新品发布/战略升级/技术成果/品牌发布/项目落地}
发布日期与地点：{日期、城市，如未知请合理留空并标注待确认}
目标受众：{媒体/投资人/客户/政府/行业伙伴/公众}
行业领域：{行业}
企业官网或官方资料：{官网链接/上传图册/产品手册/新闻资料包}
必须使用的信息：{如有，请列出}
禁止使用或避免提及的信息：{如有，请列出}
品牌调性：高端、可信、克制、国际化、专业、有新闻价值，避免空洞营销腔。

## 二、资料收集与交叉认证要求

1. 优先使用以下来源：
   - 企业官网、官方公众号、产品手册、白皮书、招股书、年报、新闻稿、认证文件；
   - 权威媒体报道；
   - 政府/协会/交易所/监管机构公开信息；
   - 行业报告、学术论文、专利数据库；
   - 用户上传的图册、产品资料、宣传册。

2. 所有重要事实必须建立“事实核验表”，至少包含：
   - 事实点
   - 来源名称
   - 来源链接或资料出处
   - 是否来自官方资料
   - 是否有第二来源佐证
   - 可信度：高/中/低
   - 是否可写入正文

3. 不得编造以下内容：
   - 企业营收、融资额、市场份额、客户名称、合作伙伴、资质认证、领导姓名与职务、发布会嘉宾、产品参数、专利数量、奖项、政府背书、上市计划。
   - 如资料不足，必须使用“待确认”或“根据公开资料暂未确认”，不得假设。

4. 如果公开资料存在冲突，必须在正文前说明冲突点，并采用更权威或更新的来源。

## 三、新闻稿写作要求

请生成一篇达到顶级商业媒体、科技媒体、财经媒体发布标准的新闻发布会稿件。

文章结构必须包括：

1. 主标题
   - 具有新闻价值，不浮夸；
   - 突出企业发布会的核心事件；
   - 不使用“震撼发布”“引领未来”等空泛表达。

2. 副标题
   - 补充战略意义、产品价值、行业背景或商业成果。

3. 导语
   - 用一段话交代时间、地点、企业、发布内容、核心意义；
   - 遵循新闻写作的 5W1H。

4. 正文主体
   按以下逻辑展开：
   - 发布会核心事件；
   - 企业背景与业务定位；
   - 产品/技术/服务亮点；
   - 行业痛点与解决方案；
   - 应用场景或客户价值；
   - 企业战略布局；
   - 对行业、客户、生态伙伴的意义；
   - 后续计划。

5. 引语设计
   - 如有真实公开引语，必须引用真实来源；
   - 如无真实引语，只能写成“发布会拟用引语”，并标注“需企业确认”；
   - 引语应体现战略高度、行业判断和企业价值，不写套话。

6. 数据与事实
   - 每个关键数据后必须加来源说明；
   - 不确定数据不得进入正文主叙事。

7. 结尾
   - 总结发布会意义；
   - 给出企业未来计划；
   - 附“关于{企业名称}”标准公司介绍；
   - 附媒体联系方式占位符。

## 四、图片与视觉策划要求

请至少设计 3 张图片，不得只是装饰图。每张图片必须服务于新闻内容，并与企业真实业务、产品或资料相符。

每张图片都要包含以下内容：
- 图片编号
- 图片用途
- 图片内容依据
- 画面构图说明
- 适合生成图片的详细 Prompt
- 建议尺寸
- Markdown 插入路径
- 图注
- alt 文本

图片类型至少包括：

### 图 1：发布会主视觉图
用途：用于文章顶部，体现企业发布主题、行业属性、产品方向与品牌气质。
要求：高端、克制、真实可信，避免虚假舞台、夸张光效和无关科技背景。

### 图 2：产品/服务/应用场景图
用途：展示企业实际产品、解决方案、工厂、门店、平台、设备、软件界面或服务场景。
要求：必须参考上传图册、官网产品图或公开资料中的真实元素进行设计。

### 图 3：业务逻辑图/技术架构图/产业价值图
用途：解释企业如何创造价值。
要求：先生成 HTML/SVG 形式的逻辑图或信息图结构，包括标题、模块、箭头、层级、说明文字；再基于该结构生成高质量视觉化图片 Prompt。

如资料丰富，可额外生成：
- 图 4：企业发展时间轴
- 图 5：行业生态合作图
- 图 6：核心产品矩阵图

图片生成标准：
- 使用专业媒体报道风格；
- 画面真实、干净、可商用；
- 避免过度科幻、虚构 Logo、虚构产品外观；
- 如涉及企业 Logo，仅在上传资料或官方资料存在时使用；
- 不生成误导性场景，例如虚构工厂、虚构客户现场、虚构领导人肖像；
- 图片内文字尽量简洁，避免大量小字；
- 建议输出 4K 或近 4K 尺寸；如需 8K，标注“需通过外部超分辨率工具二次放大”。

## 五、HTML/SVG 逻辑图要求

如新闻内容涉及技术架构、产品矩阵、产业链或业务流程，请先生成一段可运行的 HTML/SVG 逻辑图代码。

要求：
- 结构清晰；
- 适合转化为高清信息图；
- 字体层级明确；
- 颜色符合企业品牌气质；
- 不使用难以阅读的小字；
- 模块之间有清晰关系；
- 生成后再给出用于图像模型重绘优化的 Prompt。

## 六、最终 Markdown 输出格式

请严格按以下顺序输出：

# {新闻稿主标题}

> 副标题：{副标题}

![发布会主视觉图](./images/hero.png)
*图 1：{图注}*

## 导语

## 一、发布会核心信息

## 二、企业背景与业务定位

## 三、产品/技术/服务亮点

![产品或应用场景图](./images/product-scene.png)
*图 2：{图注}*

## 四、行业痛点与解决方案

## 五、应用场景与客户价值

## 六、战略布局与未来计划

![业务逻辑图](./images/business-logic.png)
*图 3：{图注}*

## 七、拟用高管引语

> 注意：如无公开真实来源，必须标注“拟用引语，需企业确认”。

## 八、关于{企业名称}

## 九、媒体联系方式

联系人：{联系人}
电话：{电话}
邮箱：{邮箱}
官网：{官网}

---

# 图片生成方案

## 图 1：发布会主视觉图
- 用途：
- 内容依据：
- 构图说明：
- 生成 Prompt：
- 建议尺寸：
- Markdown 路径：
- 图注：
- alt 文本：

## 图 2：产品/应用场景图
- 用途：
- 内容依据：
- 构图说明：
- 生成 Prompt：
- 建议尺寸：
- Markdown 路径：
- 图注：
- alt 文本：

## 图 3：业务逻辑图/技术架构图
- 用途：
- 内容依据：
- HTML/SVG 逻辑图代码：
- 重绘优化 Prompt：
- 建议尺寸：
- Markdown 路径：
- 图注：
- alt 文本：

---

# 事实核验表

| 序号 | 事实点 | 来源 | 是否官方来源 | 是否交叉认证 | 可信度 | 是否写入正文 | 备注 |
|---|---|---|---|---|---|---|---|

---

# 发布前审校清单

请逐项检查：
- 是否存在未经证实的数据；
- 是否存在虚构客户、合作伙伴、资质、奖项或排名；
- 是否存在夸大性、绝对化表述；
- 是否符合新闻稿语气，而非广告文案；
- 图片是否与企业真实业务相关；
- 图片说明是否准确；
- Markdown 图片路径是否完整；
- 引语是否标注真实来源或“需确认”；
- 是否保留待企业确认事项。`;

  const lines = [template.replaceAll("{企业名称}", companyName)];
  if (operatorNotes.trim()) {
    lines.push("", "## 操作者备注与补充资料说明", operatorNotes.trim());
  }
  return lines.join("\n");
}

function buildPublishedNewsReleasePrompt(companyName: string, operatorNotes: string) {
  const template = `你是一名资深企业新闻发布会策划人、财经科技媒体主编、品牌战略顾问、事实核查编辑和视觉创意总监。

请围绕【{企业名称}】生成一份可直接用于正式对外发布的高端新闻发布会图文新闻稿，最终输出为 Markdown 格式。

最终稿必须是面向客户、媒体和公众的成品新闻稿，不得输出任何中间过程、写作说明、图片生成 Prompt、事实核验表、审校清单、待办事项或模型自评内容。

---

## 一、基础信息

企业名称：{企业名称}

发布主题：{发布主题 / 新品发布 / 战略升级 / 技术成果 / 品牌发布 / 项目落地}

发布日期与地点：{日期、城市，如未知请不要在正文中强行编造}

目标受众：{媒体 / 投资人 / 客户 / 政府 / 行业伙伴 / 公众}

行业领域：{行业}

企业官网或官方资料：{官网链接 / 上传图册 / 产品手册 / 新闻资料包 / 官方公众号 / 白皮书 / 年报 / 招股书}

必须使用的信息：{如有，请列出}

禁止使用或避免提及的信息：{如有，请列出}

品牌调性：高端、可信、克制、国际化、专业、有新闻价值，避免空洞营销腔。

---

## 二、资料与事实要求

请优先使用以下来源完成资料判断和事实核验：

1. 企业官网、官方公众号、产品手册、白皮书、年报、招股书、新闻稿、认证文件；
2. 用户上传的图册、产品资料、宣传册、新闻资料包；
3. 权威媒体报道；
4. 政府、协会、交易所、监管机构公开信息；
5. 行业报告、学术论文、专利数据库。

所有关键事实必须可核验。不得编造以下内容：

- 企业营收；
- 融资金额；
- 市场份额；
- 客户名称；
- 合作伙伴；
- 资质认证；
- 领导姓名与职务；
- 发布会嘉宾；
- 产品参数；
- 专利数量；
- 奖项；
- 政府背书；
- 上市计划；
- 产能数据；
- 销售数据；
- 用户规模。

如资料不足，请在正文中采用克制、中性、可发布的表达方式，不得使用“待确认”“资料不足”“无法确认”等破坏成稿感的字样，也不得自行假设。

如果公开资料存在冲突，请优先采用企业官方资料、监管机构资料或更权威、更近期的来源，不要在最终新闻稿中暴露资料冲突过程。

---

## 三、新闻稿写作要求

请生成一篇达到顶级商业媒体、科技媒体、财经媒体发布标准的新闻发布会稿件。

新闻稿必须具备：

- 明确新闻事件；
- 清晰行业背景；
- 真实企业信息；
- 可信产品或服务描述；
- 具体应用价值；
- 克制的战略表达；
- 高端但不浮夸的语言；
- 媒体可直接采用的成稿质感。

文章结构包括：

### 1. 主标题

要求：

- 具有新闻价值；
- 突出发布会核心事件；
- 不浮夸；
- 不使用“震撼发布”“重磅来袭”“引领未来”“颠覆行业”等空泛表达。

### 2. 副标题

要求：

- 补充战略意义、产品价值、行业背景或商业成果；
- 与主标题形成递进关系；
- 语言克制、专业、有媒体感。

### 3. 导语

要求：

- 用一段话交代时间、地点、企业、发布内容和核心意义；
- 遵循新闻写作 5W1H；
- 不写成广告语或宣传片旁白。

### 4. 正文主体

正文请按以下逻辑自然展开：

- 发布会核心事件；
- 企业背景与业务定位；
- 产品、技术或服务亮点；
- 行业痛点与解决方案；
- 应用场景或客户价值；
- 企业战略布局；
- 对行业、客户、生态伙伴的意义；
- 后续计划。

### 5. 数据与事实

- 每个关键数据必须有可靠来源支撑；
- 不确定数据不得进入正文主叙事；
- 不得使用无法证实的排名、第一、领先、唯一、最大等绝对化表述；
- 如需引用来源，可在文末以“资料来源”形式简洁列出。

### 6. 结尾

结尾应包括：

- 本次发布会的总结性意义；
- 企业未来方向；
- “关于{企业名称}”标准公司介绍；
- 媒体联系方式。

---

## 四、图片与视觉要求

请在最终 Markdown 新闻稿中插入至少 3 张图片。图片必须服务于新闻内容，不得只是装饰图。

图片应当与企业真实业务、产品、服务、技术、应用场景或品牌气质相关，并优先参考企业官网、上传图册、产品手册、新闻资料包或公开资料中的真实元素。

图片类型至少包括：

### 图 1：发布会主视觉图

用于文章顶部，体现发布主题、企业气质、行业属性和新闻发布场景。

要求：

- 高端、克制、真实可信；
- 像真实发布会现场、企业品牌大片或媒体头图；
- 避免虚假舞台、夸张光效、廉价科技背景和无关视觉元素；
- 不得虚构不存在的 Logo、会场、嘉宾或企业标识。

### 图 2：产品 / 服务 / 应用场景图

用于展示企业实际产品、解决方案、平台、设备、工厂、门店、软件界面或服务场景。

要求：

- 必须与企业真实业务相关；
- 优先参考上传图册、官网产品图或公开资料；
- 不得凭空创造核心产品外观；
- 不得虚构客户现场、合作伙伴或具体项目；
- 如无法确认真实场景，应采用不误导读者的场景化表达。

### 图 3：业务逻辑图 / 技术架构图 / 产业价值图

用于解释企业如何创造价值，帮助读者理解企业的业务逻辑、技术路径、产品矩阵或产业位置。

要求：

- 信息结构清晰；
- 模块关系准确；
- 视觉干净专业；
- 适合媒体发布；
- 不使用复杂小字；
- 不使用赛博朋克、霓虹、全息、夸张 3D 效果；
- 风格接近专业财经媒体、咨询报告或企业招股书中的信息图。

---

## 五、图片去 AI 味儿要求

所有图片必须避免明显 AI 生成感。整体视觉应接近真实商业摄影、新闻纪实摄影、企业官网级产品摄影或专业信息图。

图片应具备：

- 真实光线；
- 真实材质；
- 真实阴影；
- 自然景深；
- 合理透视；
- 克制构图；
- 干净画面；
- 商业媒体质感；
- 企业正式对外发布素材的可信度。

图片必须避免：

- AI 海报感；
- 廉价蓝色科技感；
- 塑料质感；
- 蜡像人物；
- 畸形手指；
- 不自然笑容；
- 过度磨皮；
- 乱码文字；
- 伪 Logo；
- 虚构客户名称；
- 随机发光线条；
- 漂浮图标；
- 全息投影；
- 赛博朋克霓虹；
- 夸张镜头光斑；
- 过度锐化；
- 过饱和；
- 假 HDR；
- 素材库拼贴感；
- 概念渲染感；
- 不真实的工厂、实验室、门店、会场或产品外观。

图片内文字应尽量少，如必须出现文字，应清晰、准确、无乱码。不得在图片中加入未经确认的企业口号、数据、排名、客户名称或合作伙伴名称。

图片建议为 4K 或近 4K 质量。如需 8K，可在图像生成后通过外部超分辨率工具二次放大。

---

## 六、最终 Markdown 输出格式

请只输出以下成品新闻稿结构，不要输出任何额外说明。

---

# {新闻稿主标题}

> 副标题：{副标题}

![发布会主视觉图](./images/hero.png)
*图 1：{图注}*

## 导语

{新闻导语}

## 一、发布会核心信息

{正文内容}

## 二、企业背景与业务定位

{正文内容}

## 三、产品 / 技术 / 服务亮点

{正文内容}

![产品或应用场景图](./images/product-scene.png)
*图 2：{图注}*

## 四、行业痛点与解决方案

{正文内容}

## 五、应用场景与客户价值

{正文内容}

## 六、战略布局与未来计划

{正文内容}

![业务逻辑图](./images/business-logic.png)
*图 3：{图注}*

## 七、关于{企业名称}

{100 至 200 字企业介绍}

## 八、媒体联系方式

联系人：{联系人}
电话：{电话}
邮箱：{邮箱}
官网：{官网}

## 资料来源

{仅列出正文中实际使用的重要公开资料来源；如不适合公开展示，可删除本部分}

---

## 七、最终输出限制

最终输出必须是可直接发布的 Markdown 新闻稿。

不得出现以下内容：

- 写作思路；
- 生成步骤；
- 图片生成 Prompt；
- 负面 Prompt；
- 事实核验表；
- 发布前审校清单；
- 稿件质量自评；
- 待确认事项清单；
- “作为 AI”；
- “我建议”；
- “以下是”；
- “需要进一步确认”；
- 任何面向内部制作流程的说明。

所有不确定信息必须在写作中自然规避，不得破坏新闻稿的正式发布感。`;

  const lines = [template.replaceAll("{企业名称}", companyName)];
  if (operatorNotes.trim()) {
    lines.push("", "补充信息：", operatorNotes.trim());
  }
  return lines.join("\n");
}

async function createFrontMindTask({
  baseUrl,
  apiKey,
  prompt,
  agentProfile,
  attachments,
}: {
  baseUrl: string;
  apiKey: string;
  prompt: string;
  agentProfile?: string;
  attachments: Array<{ file_id: string; filename: string }>;
}) {
  const taskResponse = await axios.post(
    `${baseUrl}/v1/tasks`,
    {
      prompt,
      agentProfile: toUpstreamAgentProfile(agentProfile),
      taskMode: "agent",
      attachments,
    },
    {
      headers: {
        "Content-Type": "application/json",
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 120000,
      validateStatus: () => true,
    }
  );

  if (taskResponse.status < 200 || taskResponse.status >= 300) {
    const detail =
      taskResponse.data?.error?.message ||
      taskResponse.data?.message ||
      `Create task failed (${taskResponse.status})`;
    return { ok: false as const, status: taskResponse.status, detail };
  }

  const taskData = taskResponse.data || {};
  const taskId = taskData.id || taskData.task_id;
  if (!taskId) {
    return { ok: false as const, status: 502, detail: "Create task failed: missing task id" };
  }

  return {
    ok: true as const,
    task: {
      id: taskId,
      status: taskData.status === "failed" ? "error" : (taskData.status || "running"),
      taskUrl: taskData.task_url || taskData.metadata?.task_url,
      title: taskData.task_title || taskData.metadata?.task_title,
      output: taskData.output || [],
    },
  };
}

router.post("/start", async (req, res) => {
  const body = (req.body || {}) as NewsReleaseStartRequest;
  const companyName = String(body.companyName || "").trim();
  const operatorNotes = String(body.operatorNotes || "").trim();

  if (!companyName) {
    res.status(400).json({ error: "Missing company name" });
    return;
  }

  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  if (!apiKey) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }

  try {
    const userAttachments = normalizeUserAttachments(body.attachments);
    const created = await createFrontMindTask({
      baseUrl,
      apiKey,
      prompt: buildPublishedNewsReleasePrompt(companyName, operatorNotes),
      agentProfile: body.agentProfile,
      attachments: userAttachments,
    });

    if (!created.ok) {
      console.warn("[News Release Start] create task failed:", created.detail);
      res.status(created.status).json({ error: "创建新闻稿任务失败，请检查 API Key 或稍后重试" });
      return;
    }

    if (!req.frontmindUser || !req.frontmindCredential) {
      res.status(401).json({ error: "请先登录并配置 API Key" });
      return;
    }
    await recordUpstreamResource({
      userId: req.frontmindUser.id,
      apiCredentialId: req.frontmindCredential.id,
      kind: "task",
      upstreamId: String(created.task.id),
    });

    res.json({
      visibleMessage: "开始制作品牌新闻稿样例",
      task: created.task,
      startedAt: Date.now(),
    });
  } catch (error: any) {
    console.error("[News Release Start] error:", error.message);
    res.status(500).json({ error: "启动新闻稿任务失败，请稍后重试" });
  }
});

export default router;
