import { Router, type Response } from "express";

import type { FrontMindRequest } from "./_core/express-auth";
import { DeliveryTicketError } from "./delivery-ticket-error";
import {
  listIcpMaterials,
  readIcpMaterial,
  withdrawIcpMaterial,
} from "./icp-material-service";

const router = Router();

function sendError(res: Response, error: unknown) {
  if (error instanceof DeliveryTicketError) {
    res.status(error.statusCode).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  console.error("[ICP material] Request failed", error);
  res.status(500).json({
    error: {
      code: "ICP_MATERIAL_REQUEST_FAILED",
      message: "ICP 材料暂时无法处理。",
    },
  });
}

router.get("/", async (req: FrontMindRequest, res) => {
  try {
    const actor = req.frontmindUser!;
    const requestedUserId = Number(req.query.workspaceUserId);
    const workspaceUserId =
      Number.isInteger(requestedUserId) && requestedUserId > 0
        ? requestedUserId
        : actor.id;
    const materials = await listIcpMaterials({ actor, workspaceUserId });
    res.setHeader("Cache-Control", "private, no-store");
    res.json({ materials });
  } catch (error) {
    sendError(res, error);
  }
});

router.put("/upload", (_req: FrontMindRequest, res) => {
  res.status(410).json({
    error: {
      code: "ICP_MATERIAL_UPLOAD_RETIRED",
      message:
        "本站不再接收 ICP 备案材料，请前往阿里云完成材料提交与真实性核验。",
    },
  });
});

router.get("/:materialId/content", async (req: FrontMindRequest, res) => {
  try {
    const result = await readIcpMaterial({
      actor: req.frontmindUser!,
      materialId: req.params.materialId,
      expires: String(req.query.expires || ""),
      signature: String(req.query.signature || ""),
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", result.mimeType);
    res.setHeader("Content-Disposition", 'attachment; filename="ICP-material"');
    res.setHeader("Content-Length", String(result.bytes.byteLength));
    res.send(result.bytes);
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/:materialId", async (req: FrontMindRequest, res) => {
  try {
    const result = await withdrawIcpMaterial({
      actor: req.frontmindUser!,
      materialId: req.params.materialId,
    });
    res.setHeader("Cache-Control", "private, no-store");
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
