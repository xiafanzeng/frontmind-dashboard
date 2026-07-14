import type {
  AuthenticatedUser,
  DecryptedCredential,
} from "../../auth-service";

declare global {
  namespace Express {
    interface Request {
      frontmindUser?: AuthenticatedUser;
      frontmindCredential?: DecryptedCredential;
    }
  }
}

export {};
