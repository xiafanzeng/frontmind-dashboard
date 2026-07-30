const CUSTOMER_CONTENT_LEAKAGE_RULES = [
  {
    label: "过程性或批量填充表达",
    pattern:
      /补充说明|第\s*[一二三四五六七八九十百\d]+\s*个内容节点|本轮整理结果/i,
  },
  {
    label: "任务或采集过程",
    pattern:
      /本轮|本次(?:采集|任务|构建|处理|检索|核验)|本包|本知识库|抽取失败|采集失败|已核验|证据不足|未形成.{0,16}核验/i,
  },
  {
    label: "客户或采购建议",
    pattern:
      /(?:客户|采购方|读者|使用方|合作方).{0,12}(?:应|需|建议|可将)|仍应|采购(?:或|与)?合规审查|合规审查|正式尽调|不能仅凭|不宜(?:直接)?(?:转换|认定|视为)?|不能外推/i,
  },
  {
    label: "企业主张解释或模型推理",
    pattern:
      /这些内容属于企业自我定义|企业自我定义|对客户而言|可将其落实为|说明组织意图与品牌取向/i,
  },
] as const;

export function customerFormalContentViolation(value: string) {
  const normalized = value.normalize("NFKC");
  return CUSTOMER_CONTENT_LEAKAGE_RULES.find(({ pattern }) =>
    pattern.test(normalized),
  )?.label;
}
