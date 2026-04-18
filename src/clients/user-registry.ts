import fs from "fs";
import path from "path";

export type UserRole = "architect" | "manager";

export interface EnrolledUser {
  chatId: number;
  userId: number;
  phone: string;
  name: string;
  role: UserRole;
  enrolledAt: string;
}

export interface PendingUser {
  chatId: number;
  userId: number;
  phone: string;
  displayName: string;
  requestedAt: string;
}

interface RegistryFile {
  enrolled: EnrolledUser[];
  pending: PendingUser[];
}

const DEFAULT_DIR =
  process.env.TELEGRAM_DATA_DIR ||
  path.join(process.env.HOME || "~", ".redin", "telegram");

export class UserRegistry {
  private dir: string;
  private file: string;
  private state: RegistryFile = { enrolled: [], pending: [] };

  constructor(dir: string = DEFAULT_DIR) {
    this.dir = dir;
    this.file = path.join(dir, "users.json");
    this.load();
  }

  private load(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as RegistryFile;
      this.state = {
        enrolled: parsed.enrolled ?? [],
        pending: parsed.pending ?? [],
      };
    } catch (err) {
      console.error("[Registry] Load failed:", (err as Error).message);
    }
  }

  private save(): void {
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[Registry] Save failed:", (err as Error).message);
    }
  }

  findByChatId(chatId: number): EnrolledUser | null {
    return this.state.enrolled.find((u) => u.chatId === chatId) ?? null;
  }

  findByPhone(phone: string): EnrolledUser | null {
    const n = normalizePhone(phone);
    return this.state.enrolled.find((u) => normalizePhone(u.phone) === n) ?? null;
  }

  findPending(chatId: number): PendingUser | null {
    return this.state.pending.find((u) => u.chatId === chatId) ?? null;
  }

  allEnrolled(): EnrolledUser[] {
    return [...this.state.enrolled];
  }

  enroll(user: Omit<EnrolledUser, "enrolledAt">): EnrolledUser {
    this.state.enrolled = this.state.enrolled.filter((u) => u.chatId !== user.chatId);
    this.state.pending = this.state.pending.filter((u) => u.chatId !== user.chatId);
    const enrolled: EnrolledUser = { ...user, enrolledAt: new Date().toISOString() };
    this.state.enrolled.push(enrolled);
    this.save();
    return enrolled;
  }

  addPending(user: Omit<PendingUser, "requestedAt">): PendingUser {
    this.state.pending = this.state.pending.filter((u) => u.chatId !== user.chatId);
    const pending: PendingUser = { ...user, requestedAt: new Date().toISOString() };
    this.state.pending.push(pending);
    this.save();
    return pending;
  }

  removePending(chatId: number): void {
    const before = this.state.pending.length;
    this.state.pending = this.state.pending.filter((u) => u.chatId !== chatId);
    if (this.state.pending.length !== before) this.save();
  }

  removeEnrolled(chatId: number): void {
    const before = this.state.enrolled.length;
    this.state.enrolled = this.state.enrolled.filter((u) => u.chatId !== chatId);
    if (this.state.enrolled.length !== before) this.save();
  }
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}
