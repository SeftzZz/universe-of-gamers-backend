import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import Auth from "../models/Auth";

export interface AuthRequest<
  P = any,
  ResBody = any,
  ReqBody = any,
  ReqQuery = any
> extends Request<P, ResBody, ReqBody, ReqQuery> {
  user?: any;
}

export async function authenticateJWT(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Invalid Authorization header" });
  }

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET as string);
    
    // ✅ cari user di DB
    const user = await Auth.findById(decoded.id).lean();
    if (!user) return res.status(401).json({ error: "User not found" });

    // ambil wallet utama (custodial atau external)
    let walletAddress: string | null = null;
    if (user.custodialWallets?.length > 0) {
      walletAddress = user.custodialWallets[0].address;
    } else if (user.wallets?.length > 0) {
      walletAddress = user.wallets[0].address;
    }

    req.user = {
      ...decoded,
      walletAddress, // ✅ simpan address di req.user
    };

    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired token" });
  }
}

export function requireAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}
