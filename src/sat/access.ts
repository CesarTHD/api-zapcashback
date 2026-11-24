import { AuthRequest } from "../interfaces/authRequest";
import { Branches } from "./erp";

export class SatError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function access(req: AuthRequest, role?: "admin" | "operator" | "pdv") {
  const company = process.env.SAT_COMPANY_ID;
  const user = req.user;
  let claims = user?.app_metadata?.sat;
  const localAdmin = process.env.SAT_LOCAL_ADMIN_USER_ID;
  if (claims === undefined && localAdmin && user?.id === localAdmin && company === "sat-local" &&
    process.env.NODE_ENV !== "production" &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress ?? "")) {
    claims = { company, role: "admin", branches: null };
  }
  const branches = claims?.branches as Branches | undefined;
  if (!company || claims?.company !== company || !req.user ||
    (branches !== null && (!Array.isArray(branches) || !branches.length || !branches.every(Number.isSafeInteger)))) {
    throw new SatError(403, "Seu usuário ainda não tem acesso ao ZAP Cashback nesta instalação. Solicite ao administrador acesso à empresa e às filiais autorizadas.");
  }
  if (role && claims.role !== role && !(role === "operator" && claims.role === "admin")) {
    throw new SatError(403, "Permissão insuficiente");
  }
  if (!role && !["admin","operator","reader"].includes(claims.role)) {
    throw new SatError(403, "Permissão insuficiente");
  }
  return { company, branches: branches as Branches, actor: req.user.id, role: claims.role };
}

export function integer(value: unknown, minimum: number, maximum: number) {
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value))) {
    throw new SatError(400, "Número inválido");
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new SatError(400, "Número fora do intervalo");
  return result;
}

export function day(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SatError(400, "Data inválida");
  const parsed = new Date(value);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== value) throw new SatError(400, "Data inválida");
  return value;
}
