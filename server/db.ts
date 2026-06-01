import { eq, desc, gte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  dailyReports,
  stockReports,
  algorithmImprovements,
  algorithmConfig,
  type InsertDailyReport,
  type InsertStockReport,
  type InsertAlgorithmImprovement,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ============================================================
// User helpers
// ============================================================
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ============================================================
// Algorithm Config helpers
// ============================================================
export async function getAlgorithmConfig() {
  const db = await getDb();
  if (!db) return null;

  const rows = await db.select().from(algorithmConfig).limit(1);
  if (rows.length === 0) {
    await db.insert(algorithmConfig).values({
      rsiUpper: 70,
      rsiLower: 30,
      stopLossPercent: "1.5",
      largeVolumeThreshold: 8000,
      recentWinRate: "0",
      recentProfitRate: "0",
    });
    const newRows = await db.select().from(algorithmConfig).limit(1);
    return newRows[0] ?? null;
  }
  return rows[0];
}

export async function updateAlgorithmConfig(data: {
  rsiUpper?: number;
  rsiLower?: number;
  stopLossPercent?: string;
  largeVolumeThreshold?: number;
  recentWinRate?: string;
  recentProfitRate?: string;
}) {
  const db = await getDb();
  if (!db) return null;

  const existing = await getAlgorithmConfig();
  if (!existing) return null;

  await db.update(algorithmConfig).set(data).where(eq(algorithmConfig.id, existing.id));
  return getAlgorithmConfig();
}

// ============================================================
// Daily Report helpers
// ============================================================
export async function getDailyReportByDate(reportDate: string) {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(dailyReports)
    .where(eq(dailyReports.reportDate, reportDate))
    .limit(1);
  return rows[0] ?? null;
}

export async function getDailyReportList(limit = 30) {
  const db = await getDb();
  if (!db) return [];

  return db.select().from(dailyReports).orderBy(desc(dailyReports.reportDate)).limit(limit);
}

export async function getDailyReportWithStocks(reportDate: string) {
  const db = await getDb();
  if (!db) return null;

  const report = await getDailyReportByDate(reportDate);
  if (!report) return null;

  const stocks = await db
    .select()
    .from(stockReports)
    .where(eq(stockReports.dailyReportId, report.id));
  return { report, stocks };
}

export async function saveDailyReport(
  reportData: Omit<InsertDailyReport, "id" | "createdAt" | "updatedAt">,
  stockData: Omit<InsertStockReport, "id" | "dailyReportId" | "createdAt">[]
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // 既存レポートがあれば削除して再作成
  const existing = await getDailyReportByDate(reportData.reportDate);
  if (existing) {
    await db.delete(stockReports).where(eq(stockReports.dailyReportId, existing.id));
    await db.delete(dailyReports).where(eq(dailyReports.id, existing.id));
  }

  await db.insert(dailyReports).values(reportData);
  const newReport = await getDailyReportByDate(reportData.reportDate);
  if (!newReport) throw new Error("Failed to save daily report");

  if (stockData.length > 0) {
    await db.insert(stockReports).values(
      stockData.map((s) => ({ ...s, dailyReportId: newReport.id }))
    );
  }

  return newReport;
}

// ============================================================
// Algorithm Improvement helpers
// ============================================================
export async function saveAlgorithmImprovement(
  data: Omit<InsertAlgorithmImprovement, "id" | "appliedAt">
) {
  const db = await getDb();
  if (!db) return;

  await db.insert(algorithmImprovements).values(data);
}

export async function getAlgorithmImprovements(limit = 20) {
  const db = await getDb();
  if (!db) return [];

  return db
    .select()
    .from(algorithmImprovements)
    .orderBy(desc(algorithmImprovements.appliedAt))
    .limit(limit);
}

// ============================================================
// Statistics helpers
// ============================================================
export async function getRecentStats(days = 30) {
  const db = await getDb();
  if (!db) return { totalDays: 0, avgWinRate: 0, avgProfitRate: 0, totalProfit: 0, reports: [] };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const reports = await db
    .select()
    .from(dailyReports)
    .where(gte(dailyReports.reportDate, cutoffStr))
    .orderBy(desc(dailyReports.reportDate));

  if (reports.length === 0) {
    return { totalDays: 0, avgWinRate: 0, avgProfitRate: 0, totalProfit: 0, reports: [] };
  }

  const totalDays = reports.length;
  const avgWinRate =
    reports.reduce((sum, r) => sum + parseFloat(String(r.overallWinRate)), 0) / totalDays;
  const avgProfitRate =
    reports.reduce((sum, r) => sum + parseFloat(String(r.totalProfitRate)), 0) / totalDays;
  const totalProfit = reports.reduce((sum, r) => sum + Number(r.totalProfitAmount), 0);

  return { totalDays, avgWinRate, avgProfitRate, totalProfit, reports };
}
