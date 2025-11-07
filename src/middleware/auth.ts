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

/**
 * 🧩 Middleware: Wajib login
 */
export async function authenticateJWT(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
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

    console.log("🔐 [authenticateJWT] Verified user:", {
      id: user._id,
      email: user.email,
      wallet: walletAddress,
    });

    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired token" });
  }
}

/**
 * 🧩 Middleware: Opsional login (boleh tanpa JWT)
 * — digunakan untuk endpoint seperti /auth/wallet
 */
export async function optionalAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.log("⚙️ [optionalAuth] No Authorization header — guest mode");
    return next();
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    console.log("⚠️ [optionalAuth] Malformed Authorization header");
    return next();
  }

  try {
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET as string);
    const user = await Auth.findById(decoded.id).lean();

    if (user) {
      req.user = {
        id: user._id,
        email: user.email,
        role: user.role,
        walletAddress:
          user.custodialWallets?.[0]?.address || user.wallets?.[0]?.address || null,
      };

      console.log("🔐 [optionalAuth] Authenticated user:", {
        id: user._id,
        email: user.email,
        wallet: req.user.walletAddress,
      });
    } else {
      console.warn("⚠️ [optionalAuth] JWT valid but user not found");
    }
  } catch (err) {
    console.warn("⚠️ [optionalAuth] Invalid or expired token — continuing guest");
  }

  next();
}

/**
 * 🧩 Middleware: Admin only
 */
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
