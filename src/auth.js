import { Router } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { User } from "./models.js";

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const sign = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
const pub = (u) => ({ id: u._id, name: u.name, email: u.email, role: u.role });

export async function requireAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const { id } = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(id);
    if (!user) throw new Error("no user");
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Please log in" });
  }
}

export const auth = Router();

auth.post("/register", wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || String(password).length < 6)
    return res.status(400).json({ error: "Name, email and a password of at least 6 characters are required" });
  if (await User.findOne({ email: String(email).toLowerCase() }))
    return res.status(409).json({ error: "This email is already registered" });
  const user = await User.create({ name, email, passwordHash: await bcrypt.hash(String(password), 10) });
  res.json({ token: sign(user), user: pub(user) });
}));

auth.post("/login", wrap(async (req, res) => {
  const user = await User.findOne({ email: String(req.body.email || "").toLowerCase() });
  if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.passwordHash)))
    return res.status(400).json({ error: "Wrong email or password" });
  res.json({ token: sign(user), user: pub(user) });
}));

auth.get("/me", requireAuth, (req, res) => res.json(pub(req.user)));
