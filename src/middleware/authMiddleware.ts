import { NextFunction, Response } from "express";

import { supabase } from "../libs/supabase";
import { AuthRequest } from "../interfaces/authRequest";

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const {
      data: { user },
      error
    } = await supabase.auth.getUser(token as string);

    if (error || !user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    req.user = user;

    return next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
};

export default authMiddleware;
