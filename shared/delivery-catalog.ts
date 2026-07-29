/**
 * Product-level delivery catalog. It is returned by the server workspace
 * endpoint and never embedded in tenant-facing components or tenant payloads.
 * Tenant-specific availability is still determined by service entitlement.
 */
export const CONTENT_ASSET_CATALOG = Object.freeze([
  {
    id: "A1",
    code: "A1",
    group: "A",
    type: "品牌事实内容",
    label: "企业资料与品牌事实",
    description: "整理企业简介、发展历程、资质荣誉等可核验的品牌事实。",
  },
  {
    id: "A2",
    code: "A2",
    group: "A",
    type: "案例内容",
    label: "用户案例与成功故事",
    description: "将项目背景、解决方案与量化成果整理为可信客户案例。",
  },
  {
    id: "B1",
    code: "B1",
    group: "B",
    type: "行业内容",
    label: "行业观点与趋势观察",
    description: "围绕行业变化、关键议题和专业判断形成深度观点内容。",
  },
  {
    id: "B2",
    code: "B2",
    group: "B",
    type: "产品内容",
    label: "产品能力与应用场景",
    description: "清晰说明产品能力、适用场景、使用方式与选择依据。",
  },
  {
    id: "C1",
    code: "C1",
    group: "C",
    type: "新闻内容",
    label: "企业新闻与动态",
    description: "发布企业进展、合作动态、活动信息与重要里程碑。",
  },
  {
    id: "D1",
    code: "D1",
    group: "D",
    type: "问答内容",
    label: "知乎问答",
    description: "围绕用户真实问题输出专业、自然且有事实支撑的回答。",
  },
] as const);

export const WEBSITE_CONTENT_CATALOG = Object.freeze([
  { value: "company_facts", label: "企业资料与品牌事实" },
  { value: "product_case_docs", label: "产品案例与文档" },
  { value: "industry_news", label: "行业新闻与观察" },
  { value: "company_news", label: "企业新闻与动态" },
  { value: "faq_content", label: "FAQ 与问答页面" },
] as const);

export const DOMESTIC_CONTENT_ASSET_MEDIA_OPTIONS = Object.freeze([
  "今日头条",
  "搜狐",
  "网易",
  "腾讯",
  "新浪",
  "百度",
  "中华网",
  "凤凰网",
  "微博",
] as const);

export const OVERSEAS_CONTENT_ASSET_MEDIA_OPTIONS = Object.freeze([
  "美联社",
  "今日美国",
  "雅虎",
  "Business Insider",
  "Barchart",
] as const);

export const ALL_CONTENT_ASSET_MEDIA_OPTIONS = Object.freeze([
  ...DOMESTIC_CONTENT_ASSET_MEDIA_OPTIONS,
  ...OVERSEAS_CONTENT_ASSET_MEDIA_OPTIONS,
] as const);

/** Backward-compatible alias for existing domestic-edition callers. */
export const CONTENT_ASSET_MEDIA_OPTIONS = DOMESTIC_CONTENT_ASSET_MEDIA_OPTIONS;

export function contentAssetMediaOptionsForMarketEdition(
  marketEdition: "domestic" | "overseas",
) {
  return marketEdition === "overseas"
    ? OVERSEAS_CONTENT_ASSET_MEDIA_OPTIONS
    : DOMESTIC_CONTENT_ASSET_MEDIA_OPTIONS;
}

export const ICP_PROVINCES = Object.freeze([
  "北京",
  "天津",
  "河北",
  "山西",
  "内蒙古",
  "辽宁",
  "吉林",
  "黑龙江",
  "上海",
  "江苏",
  "浙江",
  "安徽",
  "福建",
  "江西",
  "山东",
  "河南",
  "湖北",
  "湖南",
  "广东",
  "广西",
  "海南",
  "重庆",
  "四川",
  "贵州",
  "云南",
  "西藏",
  "陕西",
  "甘肃",
  "青海",
  "宁夏",
  "新疆",
] as const);

export type IcpMaterialChecklistItem = {
  key: string;
  label: string;
  sensitive: boolean;
  required: boolean;
  note?: string;
};

const ICP_BASE_MATERIALS: readonly IcpMaterialChecklistItem[] = Object.freeze([
  {
    key: "business_license",
    label: "主办单位证件（营业执照）",
    sensitive: true,
    required: true,
  },
  {
    key: "subject_responsible_person_id",
    label: "主体负责人有效身份证件",
    sensitive: true,
    required: true,
  },
  {
    key: "website_responsible_person_id",
    label: "网站负责人有效身份证件",
    sensitive: true,
    required: true,
  },
  {
    key: "domain_holder_information",
    label: "域名实名及持有人信息",
    sensitive: false,
    required: true,
  },
  {
    key: "website_information",
    label: "网站名称、服务内容和联系方式",
    sensitive: false,
    required: true,
  },
  {
    key: "aliyun_app_verification",
    label: "阿里云 App 真实性 / 人脸核验完成状态",
    sensitive: false,
    required: true,
  },
]);

const ICP_COMMON_CONDITIONAL_MATERIALS: readonly IcpMaterialChecklistItem[] =
  Object.freeze([
    {
      key: "authorization_letter",
      label: "负责人授权书",
      sensitive: true,
      required: false,
      note: "仅在当地管局允许负责人非法定代表人且要求授权时提供。",
    },
    {
      key: "pre_approval_or_industry_qualification",
      label: "前置审批或行业资质",
      sensitive: true,
      required: false,
      note: "涉及需要前置审批的互联网信息服务时提供。",
    },
    {
      key: "enterprise_name_change_proof",
      label: "企业名称变更证明",
      sensitive: true,
      required: false,
      note: "证件、域名或历史备案主体名称不一致时提供。",
    },
  ]);

const ICP_PROVINCE_SPECIFIC_MATERIALS: Readonly<
  Record<string, IcpMaterialChecklistItem>
> = Object.freeze({
  北京: {
    key: "other_provincial_material",
    label: "北京管局补充材料",
    sensitive: true,
    required: false,
    note: "政府或事业单位等特殊主体按备案系统要求补充上级部门函件；以当前订单提示为准。",
  },
  广东: {
    key: "other_provincial_material",
    label: "广东省互联网信息服务备案承诺书及管局补充材料",
    sensitive: true,
    required: true,
    note: "承诺书需按阿里云备案订单当前模板签字盖章；证件住所非广东时还应按订单要求补充居住、房产或社保证明。",
  },
  天津: {
    key: "other_provincial_material",
    label: "天津地区互联网信息服务内容说明",
    sensitive: true,
    required: true,
    note: "使用阿里云备案订单当前模板填写并按管局要求签署。",
  },
});

/**
 * Province-specific requirements are resolved on the server. This is not a
 * legal assertion that every listed optional item is always required; it
 * deliberately tells the customer that the administrator must confirm the
 * local authority's current checklist before submission.
 */
export function icpMaterialChecklistForProvince(
  province: string,
): IcpMaterialChecklistItem[] {
  const normalized = province.trim();
  if (!ICP_PROVINCES.includes(normalized as (typeof ICP_PROVINCES)[number])) {
    return [];
  }
  const provinceSpecific = ICP_PROVINCE_SPECIFIC_MATERIALS[normalized] ?? {
    key: "other_provincial_material",
    label: `${normalized}通信管理局要求的其他材料`,
    sensitive: true,
    required: false,
    note: "以提交时当地管局和阿里云备案系统返回的清单为准。",
  };
  return [
    ...ICP_BASE_MATERIALS,
    ...ICP_COMMON_CONDITIONAL_MATERIALS,
    provinceSpecific,
  ];
}
