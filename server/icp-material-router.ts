import express, { Router, type Response } from "express";

import { icpSensitiveMaterialCategorySchema } from "../shared/delivery-ticket";
import type { FrontMindRequest } from "./_core/express-auth";
import { DeliveryTicketError } from "./delivery-ticket-error";
import {
  listIcpMaterials,
  readIcpMaterial,
  storeIcpMaterial,
  withdrawIcpMaterial,
} from "./icp-material-service";

const router = Router();

function decodedHeader(value: string | string[] | undefined, fallback: string) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return fallback;
  try {
    return decodeURIComponent(raw).slice(0, 512);
  } catch {
    return raw.slice(0, 512);
  }
}

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

router.put(
  "/upload",
  express.raw({ type: "application/octet-stream", limit: "20mb" }),
  async (req: FrontMindRequest, res) => {
    try {
      const actor = req.frontmindUser!;
      const requestedUserId = Number(req.header("x-workspace-user-id"));
      const workspaceUserId =
        Number.isInteger(requestedUserId) && requestedUserId > 0
          ? requestedUserId
          : actor.id;
      const category = icpSensitiveMaterialCategorySchema.parse(
        req.header("x-icp-material-category"),
      );
      const result = await storeIcpMaterial({
        actor,
        workspaceUserId,
        filename: decodedHeader(req.headers["x-file-name"], "ICP 材料"),
        mimeType: decodedHeader(
          req.headers["x-file-content-type"],
          "application/octet-stream",
        ),
        category,
        bytes: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        replacesMaterialId:
          req.header("x-replaces-material-id")?.trim() || null,
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  },
);

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
    res.setHeader("Content-Disposition", "attachment; filename=\"ICP-material\"");
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
