import type {
  AuthenticatedUser,
  DecryptedCredential,
} from "../../auth-service";
import type { DeliveryRoleType } from "../../../shared/delivery-roles";

declare global {
  namespace Express {
    interface Request {
      frontmindUser?: AuthenticatedUser;
      frontmindCredential?: DecryptedCredential;
      frontmindDeliveryRoleContext?: {
        assignmentId: string;
        roleId: string;
        roleType: DeliveryRoleType;
        teamName: string;
      };
    }
  }
}

export {};
