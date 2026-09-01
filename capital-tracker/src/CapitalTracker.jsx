import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell,
} from "recharts";
import {
  Wallet, TrendingUp, TrendingDown, PiggyBank, Target, Trash2, Plus,
  LayoutGrid, ArrowDownCircle, ArrowUpCircle, ChevronDown, RefreshCw,
  Download, Upload, LogOut,
} from "lucide-react";
import { auth, db } from "./firebase";
import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------
const COLORS = {
  bg: "#F5F6F8",
  card: "#FFFFFF",
  border: "#E7E9EC",
  text: "#111827",
  sub: "#6B7280",
  green: "#15803D",
  greenBg: "#E8F5EC",
  red: "#B91C1C",
  redBg: "#FBEAEA",
  blue: "#1D4ED8",
  blueBg: "#E9EFFD",
  violet: "#7C3AED",
  violetBg: "#F1EAFD",
  amber: "#B45309",
  amberBg: "#FBF0DF",
};

const TYPE_COLOR = {
  "Карта": "#2563EB",
  "Депозит": "#DB2777",
  "Подушка": "#F59E0B",
  "Акции": "#7C3AED",
  "Облигации": "#0891B2",
  "Наличные": "#16A34A",
  "Валюта": "#9A3412",
  "Долг/кредит": "#DC2626",
};

const MONTHS_RU = ["Янв","Фев","Мар","Апр","Май","Июн","Июл","Авг","Сен","Окт","Ноя","Дек"];
const ACCOUNT_TYPES = ["Карта", "Наличные", "Подушка", "Депозит", "Акции", "Облигации", "Валюта", "Долг/кредит"];
// счета этих типов можно выбрать в формах Доходов/Расходов — Акции и Облигации пополняются только через Капитал/переводы
const TRANSACTABLE_TYPES = ["Карта", "Наличные", "Подушка", "Депозит", "Валюта", "Долг/кредит"];
const INCOME_CATS = ["Зарплата", "Подработка", "Дивиденды", "Купоны", "Проценты на остаток", "Прочее"];
const EXPENSE_CATS = ["Аренда", "Коммунальные платежи", "Интернет и связь", "Продукты и хозтовары", "Транспорт", "Образование", "Здоровье и красота", "Развлечения", "Путешествия", "Одежда", "Непредвиденное", "Прочие расходы"];

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const fmtRub = (n) => {
  const sign = n < 0 ? "-" : "";
  return sign + Math.round(Math.abs(n)).toLocaleString("ru-RU") + " ₽";
};
const fmtRubSigned = (n) => (n > 0 ? "+" : n < 0 ? "-" : "") + Math.round(Math.abs(n)).toLocaleString("ru-RU") + " ₽";
const fmtPct = (n) => (n > 0 ? "+" : n < 0 ? "-" : "") + Math.abs(n * 100).toFixed(1) + "%";
const fmtPctPlain = (n) => (Math.abs(n) * 100).toFixed(1) + "%";

const fmtRateRub = (n) => n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₽";

// compact axis label: 0..999 as-is, 1k..999k as "Nk", 1M+ as "N.NM"
const fmtCompact = (v) => {
  const abs = Math.abs(v);
  if (abs >= 1000000) return (v / 1000000).toFixed(abs % 1000000 === 0 ? 0 : 1) + "M";
  if (abs >= 1000) return Math.round(v / 1000) + "k";
  return String(Math.round(v));
};

// левое выравнивание подписей оси Y — по умолчанию Recharts прижимает их
// вправо (к линиям сетки), из-за чего цифры съезжают от заголовка карточки
const YAxisTickLeft = ({ y, payload }) => (
  <text x={0} y={y} dy={4} textAnchor="start" fontSize={11} fill={COLORS.sub}>
    {fmtCompact(payload.value)}
  </text>
);

// ---------------------------------------------------------------------------
// Currency accounts: счета типа "Валюта" хранят остаток и суммы операций в
// СВОИХ единицах (доллары/евро), а не в рублях. Курс ЦБ (rates.usd/rates.eur,
// см. TrackerApp) применяется только в момент подсчёта — чтобы включить такой
// счёт в общий капитал в рублях, где угодно, где он суммируется.
// ---------------------------------------------------------------------------
const CURRENCY_CODES = ["USD", "EUR"];
const CURRENCY_SYMBOL = { USD: "$", EUR: "€" };
const accountCurrency = (acc) => (acc && acc.type === "Валюта" ? (acc.currency || "USD") : "RUB");
const rateForCurrency = (code, rates) => (code === "USD" ? rates.usd : code === "EUR" ? rates.eur : 1);
// amount — число в единицах `code` (или в рублях, если code === "RUB")
const toRub = (amount, code, rates) => {
  const n = Number(amount) || 0;
  if (code === "RUB") return n;
  const r = rateForCurrency(code, rates);
  return r ? n * r : 0; // курс ещё не загружен — пока считаем как 0, а не искажаем итог
};
const fmtCur = (n, code) => {
  const sign = n < 0 ? "-" : "";
  return sign + Math.abs(n).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + (CURRENCY_SYMBOL[code] || code);
};

const monthKey = (dateStr) => dateStr.slice(0, 7); // "YYYY-MM"
const monthLabel = (key) => {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS_RU[m - 1]} ${y}`;
};
const addMonths = (key, n) => {
  const [y, m] = key.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
};
const todayKey = () => new Date().toISOString().slice(0, 7);
const todayStr = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Default / seed data
// ---------------------------------------------------------------------------
const defaultAccounts = () => ([
  { id: uid(), name: "Карта", type: "Карта", opening: 80000 },
  { id: uid(), name: "Наличные", type: "Наличные", opening: 20000 },
  { id: uid(), name: "Депозит", type: "Депозит", opening: 300000 },
  { id: uid(), name: "Акции", type: "Акции", opening: 220000 },
  { id: uid(), name: "Облигации", type: "Облигации", opening: 100000 },
  { id: uid(), name: "Подушка", type: "Подушка", opening: 150000 },
  { id: uid(), name: "Валюта (USD)", type: "Валюта", currency: "USD", opening: 1000 },
  { id: uid(), name: "Валюта (EUR)", type: "Валюта", currency: "EUR", opening: 600 },
]);

const defaultTransactions = () => {
  const acc = { card: "Карта", cash: "Наличные", pillow: "Подушка", dep: "Депозит", cur: "Валюта (USD)", eur: "Валюта (EUR)" };
  const mk = (date, category, description, amount, account, type) => ({
    id: uid(), date, category, description, amount, account, type,
  });
  const mkT = (date, fromAccount, toAccount, amount) => ({
    id: uid(), date, fromAccount, toAccount, amount, type: "transfer",
  });
  return [
    // январь 2026
    mk("2026-01-05", "Зарплата", "Зарплата за январь", 150000, acc.card, "income"),
    mk("2026-01-01", "Аренда", "Аренда квартиры", 45000, acc.card, "expense"),
    mk("2026-01-10", "Продукты и хозтовары", "Продукты за январь", 25000, acc.cash, "expense"),
    mk("2026-01-15", "Транспорт", "Транспорт", 8000, acc.card, "expense"),
    mk("2026-01-20", "Развлечения", "Развлечения", 6000, acc.cash, "expense"),
    mkT("2026-01-06", acc.card, acc.pillow, 30000),

    // февраль 2026
    mk("2026-02-05", "Зарплата", "Зарплата за февраль", 150000, acc.card, "income"),
    mk("2026-02-18", "Дивиденды", "Дивиденды по валютному счёту", 55, acc.cur, "income"),
    mk("2026-02-01", "Аренда", "Аренда квартиры", 45000, acc.card, "expense"),
    mk("2026-02-10", "Продукты и хозтовары", "Продукты за февраль", 24000, acc.cash, "expense"),
    mk("2026-02-12", "Коммунальные платежи", "ЖКХ", 7000, acc.card, "expense"),
    mk("2026-02-14", "Интернет и связь", "Интернет и мобильная связь", 1500, acc.card, "expense"),
    mk("2026-02-22", "Развлечения", "Развлечения", 9000, acc.cash, "expense"),
    mkT("2026-02-06", acc.card, acc.dep, 50000),

    // март 2026
    mk("2026-03-05", "Зарплата", "Зарплата за март", 150000, acc.card, "income"),
    mk("2026-03-20", "Подработка", "Квартальная премия", 80000, acc.card, "income"),
    mk("2026-03-01", "Аренда", "Аренда квартиры", 45000, acc.card, "expense"),
    mk("2026-03-10", "Продукты и хозтовары", "Продукты за март", 26000, acc.cash, "expense"),
    mk("2026-03-15", "Транспорт", "Транспорт", 9000, acc.card, "expense"),
    mk("2026-03-18", "Одежда", "Одежда", 12000, acc.card, "expense"),
    mk("2026-03-25", "Здоровье и красота", "Здоровье и красота", 5000, acc.cash, "expense"),
    mkT("2026-03-06", acc.card, "Акции", 40000),

    // апрель 2026
    mk("2026-04-05", "Зарплата", "Зарплата за апрель", 150000, acc.card, "income"),
    mk("2026-04-12", "Подработка", "Проект на фрилансе", 330, acc.cur, "income"),
    mk("2026-04-01", "Аренда", "Аренда квартиры", 45000, acc.card, "expense"),
    mk("2026-04-10", "Продукты и хозтовары", "Продукты за апрель", 23000, acc.cash, "expense"),
    mk("2026-04-14", "Транспорт", "Транспорт", 8500, acc.card, "expense"),
    mk("2026-04-20", "Путешествия", "Поездка на выходные", 40000, acc.card, "expense"),
    mk("2026-04-25", "Развлечения", "Развлечения", 7000, acc.cash, "expense"),
    mkT("2026-04-06", acc.card, "Облигации", 25000),

    // май 2026
    mk("2026-05-05", "Зарплата", "Зарплата за май", 150000, acc.card, "income"),
    mk("2026-05-01", "Аренда", "Аренда квартиры", 45000, acc.card, "expense"),
    mk("2026-05-10", "Продукты и хозтовары", "Продукты за май", 24500, acc.cash, "expense"),
    mk("2026-05-12", "Транспорт", "Транспорт", 8200, acc.card, "expense"),
    mk("2026-05-18", "Образование", "Онлайн-курс", 15000, acc.card, "expense"),
    mk("2026-05-24", "Развлечения", "Развлечения", 8000, acc.cash, "expense"),
    mkT("2026-05-06", acc.card, "Акции", 40000),

    // июнь 2026
    mk("2026-06-05", "Зарплата", "Зарплата за июнь", 150000, acc.card, "income"),
    mk("2026-06-01", "Проценты на остаток", "Проценты по Подушке", 2000, acc.pillow, "income"),
    mk("2026-06-01", "Проценты на остаток", "Проценты по вкладу", 12000, acc.dep, "income"),
    mk("2026-06-01", "Аренда", "Аренда квартиры", 45000, acc.card, "expense"),
    mk("2026-06-10", "Продукты и хозтовары", "Продукты за июнь", 24000, acc.cash, "expense"),
    mk("2026-06-12", "Транспорт", "Транспорт", 8000, acc.card, "expense"),
    mk("2026-06-20", "Развлечения", "Развлечения", 10000, acc.cash, "expense"),
    mk("2026-06-25", "Непредвиденное", "Ремонт техники", 18000, acc.card, "expense"),
    mkT("2026-06-06", acc.card, acc.pillow, 20000),

    // июль 2026
    mk("2026-07-05", "Зарплата", "Зарплата за июль", 150000, acc.card, "income"),
    mk("2026-07-15", "Дивиденды", "Дивиденды по валютному счёту", 65, acc.cur, "income"),
    mk("2026-07-01", "Аренда", "Аренда квартиры", 45000, acc.card, "expense"),
    mk("2026-07-10", "Продукты и хозтовары", "Продукты за июль", 25500, acc.cash, "expense"),
    mk("2026-07-14", "Транспорт", "Транспорт", 8300, acc.card, "expense"),
    mk("2026-07-20", "Путешествия", "Отпуск", 500, acc.eur, "expense"),
    mk("2026-07-25", "Развлечения", "Развлечения", 9000, acc.cash, "expense"),
    mkT("2026-07-06", acc.card, acc.dep, 35000),

    // август 2026
    mk("2026-08-05", "Зарплата", "Зарплата за август", 150000, acc.card, "income"),
    mk("2026-08-20", "Подработка", "Премия по итогам полугодия", 60000, acc.card, "income"),
    mk("2026-08-01", "Аренда", "Аренда квартиры", 45000, acc.card, "expense"),
    mk("2026-08-10", "Продукты и хозтовары", "Продукты за август", 26000, acc.cash, "expense"),
    mk("2026-08-12", "Коммунальные платежи", "ЖКХ", 7500, acc.card, "expense"),
    mk("2026-08-18", "Здоровье и красота", "Здоровье и красота", 6000, acc.cash, "expense"),
    mk("2026-08-22", "Прочие расходы", "Разные мелкие траты", 4000, acc.card, "expense"),
    mkT("2026-08-06", acc.card, "Акции", 30000),
  ];
};

// ---------------------------------------------------------------------------
// Small UI primitives
// ---------------------------------------------------------------------------
const Card = ({ children, style, className = "" }) => (
  <div
    className={`rounded-2xl ${className}`}
    style={{ background: COLORS.card, border: `1px solid ${COLORS.border}`, boxShadow: "0 1px 2px rgba(16,24,40,0.04)", ...style }}
  >
    {children}
  </div>
);

const IconBadge = ({ icon: Icon, fg, bg, size = 36 }) => (
  <div className="flex items-center justify-center rounded-full shrink-0" style={{ width: size, height: size, background: bg }}>
    <Icon size={Math.round(size * 0.5)} color={fg} />
  </div>
);

const Delta = ({ value, isPct, favorable }) => {
  if (value === null || value === undefined || !isFinite(value)) return null;
  const good = favorable ? value >= 0 : value < 0;
  const color = good ? COLORS.green : COLORS.red;
  return (
    <span className="text-xs font-semibold" style={{ color }}>
      {isPct ? fmtPct(value) : fmtRubSigned(value)}
    </span>
  );
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
function TrackerApp({ userId, userEmail, onSignOut }) {
  const [tab, setTab] = useState("summary");
  const [loaded, setLoaded] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [goal, setGoal] = useState(10000000);
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [period, setPeriod] = useState("month"); // 'month' | 'half' | 'year'

  // ---- load from Firestore ----
  // Данные лежат в документе users/{uid} — привязаны к аккаунту, а не к браузеру,
  // поэтому одинаковы на телефоне, ноутбуке — где угодно, где выполнен вход.
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(doc(db, "users", userId));
        if (snap.exists()) {
          const data = snap.data();
          setTransactions(data.transactions || defaultTransactions());
          let loadedAccounts = data.accounts || defaultAccounts();
          if (!loadedAccounts.some((a) => a.type === "Карта")) {
            loadedAccounts = [{ id: uid(), name: "Карта", type: "Карта", opening: 0 }, ...loadedAccounts];
          }
          setAccounts(loadedAccounts);
          setGoal(typeof data.goal === "number" ? data.goal : 10000000);
          if (data.rates && (data.rates.usd || data.rates.eur)) {
            setRates((r) => ({ ...r, usd: data.rates.usd, eur: data.rates.eur, updatedAt: data.rates.updatedAt }));
          }
        } else {
          setTransactions(defaultTransactions());
          setAccounts(defaultAccounts());
        }
      } catch (e) {
        setTransactions(defaultTransactions());
        setAccounts(defaultAccounts());
      } finally {
        setLoaded(true);
      }
    })();
  }, [userId]);

  // ---- USD/EUR → RUB exchange rates (ЦБ РФ, auto-refreshed) ----
  const [rates, setRates] = useState({ usd: null, eur: null, updatedAt: null, loading: false, error: null });

  const fetchRates = useCallback(async () => {
    setRates((r) => ({ ...r, loading: true, error: null }));
    try {
      // Публичное зеркало курсов ЦБ РФ: отдаёт JSON прямо в браузер, без ключа
      // и без CORS-проблем — в отличие от api.anthropic.com, который работает
      // только изнутри артефактов Claude.ai (там прокси сам подставляет ключ).
      const res = await fetch("https://www.cbr-xml-daily.ru/daily_json.js");
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      const usd = Number(data?.Valute?.USD?.Value);
      const eur = Number(data?.Valute?.EUR?.Value);
      if (!usd || !eur) throw new Error("no data");
      setRates({ usd, eur, updatedAt: new Date().toISOString(), loading: false, error: null });
    } catch (e) {
      setRates((r) => ({ ...r, loading: false, error: "Не удалось обновить курс" }));
    }
  }, []);

  // fetch once on load, then keep refreshing in the background every hour
  useEffect(() => {
    fetchRates();
    const id = setInterval(fetchRates, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchRates]);

  // ---- persist on change ----
  // Debounced: writes fire ~400ms after the last change, so fast successive edits
  // (e.g. deleting several operations in a row) don't trigger a write per keystroke.
  const saveTimeoutRef = useRef(null);
  const latestPayloadRef = useRef(null);

  const flushSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (latestPayloadRef.current === null) return;
    const payload = latestPayloadRef.current;
    latestPayloadRef.current = null;
    setDoc(doc(db, "users", userId), payload).catch(() => {
      // офлайн/сеть недоступна — Firestore сам повторит запись, когда связь восстановится
    });
  }, [userId]);

  useEffect(() => {
    if (!loaded) return;
    latestPayloadRef.current = {
      transactions, accounts, goal,
      rates: { usd: rates.usd, eur: rates.eur, updatedAt: rates.updatedAt },
    };
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(flushSave, 400);
  }, [transactions, accounts, goal, rates.usd, rates.eur, rates.updatedAt, loaded, flushSave]);

  // make sure a pending save isn't lost if the tab/file closes right after an edit
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flushSave(); };
    window.addEventListener("beforeunload", flushSave);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", flushSave);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [flushSave]);

  // default selected month = latest month with data, or current month
  useEffect(() => {
    if (!loaded || selectedMonth) return;
    if (transactions.length) {
      const keys = transactions.map((t) => monthKey(t.date)).sort();
      setSelectedMonth(keys[keys.length - 1]);
    } else {
      setSelectedMonth(todayKey());
    }
  }, [loaded, transactions, selectedMonth]);

  const addTransaction = useCallback((tx) => {
    setTransactions((prev) => [...prev, { ...tx, id: uid() }]);
  }, []);
  const deleteTransaction = useCallback((id) => {
    setTransactions((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ---- export / import JSON (бэкап и перенос данных между браузерами/устройствами) ----
  const exportData = useCallback(() => {
    const payload = JSON.stringify(
      { transactions, accounts, goal, rates: { usd: rates.usd, eur: rates.eur, updatedAt: rates.updatedAt } },
      null,
      2
    );
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `capital-tracker-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [transactions, accounts, goal, rates.usd, rates.eur, rates.updatedAt]);

  const importData = useCallback((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        setTransactions(Array.isArray(data.transactions) ? data.transactions : []);
        let loadedAccounts = Array.isArray(data.accounts) && data.accounts.length ? data.accounts : defaultAccounts();
        if (!loadedAccounts.some((a) => a.type === "Карта")) {
          loadedAccounts = [{ id: uid(), name: "Карта", type: "Карта", opening: 0 }, ...loadedAccounts];
        }
        setAccounts(loadedAccounts);
        setGoal(typeof data.goal === "number" ? data.goal : 10000000);
        if (data.rates && (data.rates.usd || data.rates.eur)) {
          setRates((r) => ({ ...r, usd: data.rates.usd, eur: data.rates.eur, updatedAt: data.rates.updatedAt }));
        }
      } catch (e) {
        alert("Не удалось прочитать файл — проверьте, что это JSON-экспорт из этого трекера.");
      }
    };
    reader.readAsText(file);
  }, []);

  const updateAccountOpening = useCallback((id, opening) => {
    setAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, opening } : a)));
  }, []);
  const addAccount = useCallback((acc) => {
    setAccounts((prev) => [...prev, { ...acc, id: uid() }]);
  }, []);

  const availableMonths = useMemo(() => {
    const set = new Set(transactions.map((t) => monthKey(t.date)));
    set.add(selectedMonth || todayKey());
    return Array.from(set).sort();
  }, [transactions, selectedMonth]);

  const currentCapital = useMemo(() => {
    return accounts.reduce((s, a) => {
      const code = accountCurrency(a);
      const sumRub = (pred) => transactions.filter(pred).reduce((sum, t) => sum + toRub(t.amount, code, rates), 0);
      const openingRub = toRub(a.opening, code, rates);
      const inc = sumRub((t) => t.type === "income" && t.account === a.name);
      const exp = sumRub((t) => t.type === "expense" && t.account === a.name);
      return s + openingRub + inc - exp;
    }, 0);
  }, [accounts, transactions, rates.usd, rates.eur]);

  // capital as of the end of a given month (opening balances + all income/expense up to that date)
  const capitalAtEnd = useCallback((mKeyArg) => {
    const endStr = mKeyArg + "-31";
    return accounts.reduce((s, a) => {
      const code = accountCurrency(a);
      const openingRub = toRub(a.opening, code, rates);
      const inc = transactions.filter((t) => t.type === "income" && t.account === a.name && t.date <= endStr)
        .reduce((sum, t) => sum + toRub(t.amount, code, rates), 0);
      const exp = transactions.filter((t) => t.type === "expense" && t.account === a.name && t.date <= endStr)
        .reduce((sum, t) => sum + toRub(t.amount, code, rates), 0);
      return s + openingRub + inc - exp;
    }, 0);
  }, [accounts, transactions, rates.usd, rates.eur]);

  // % change in capital over the selected period (month / half year / year), for the badge next to the total
  const capitalDelta = useMemo(() => {
    const mKey = selectedMonth || availableMonths[availableMonths.length - 1];
    const periodN = period === "month" ? 1 : period === "half" ? 6 : 12;
    const prevPeriodEndKey = addMonths(mKey, -periodN);
    const capitalBefore = capitalAtEnd(prevPeriodEndKey);
    return capitalBefore ? (capitalAtEnd(mKey) - capitalBefore) / Math.abs(capitalBefore) : null;
  }, [selectedMonth, availableMonths, period, capitalAtEnd]);

  // count + total for the active income/expense/transfer tab, shown in the top nav
  const activeTypeStats = useMemo(() => {
    if (tab !== "income" && tab !== "expense" && tab !== "transfer") return null;
    const list = transactions.filter((t) => t.type === tab);
    const total = list.reduce((s, t) => {
      const accName = tab === "transfer" ? t.fromAccount : t.account;
      const acc = accounts.find((a) => a.name === accName);
      return s + toRub(t.amount, accountCurrency(acc), rates);
    }, 0);
    return { count: list.length, total };
  }, [transactions, tab, accounts, rates.usd, rates.eur]);

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-64" style={{ color: COLORS.sub }}>
        Загрузка…
      </div>
    );
  }

  return (
    <div style={{ background: COLORS.bg, minHeight: "100%", color: COLORS.text, scrollbarGutter: "stable" }} className="font-sans">
      <style>{`html, body { scrollbar-gutter: stable; }`}</style>
      <div className="max-w-6xl mx-auto px-3 py-4 sm:px-4 sm:py-6">
        <TopNav
          tab={tab} setTab={setTab}
          period={period} setPeriod={setPeriod}
          selectedMonth={selectedMonth || availableMonths[availableMonths.length - 1]}
          setSelectedMonth={setSelectedMonth}
          availableMonths={availableMonths}
          currentCapital={currentCapital}
          capitalDelta={capitalDelta}
          activeTypeStats={activeTypeStats}
          exportData={exportData}
          importData={importData}
          userEmail={userEmail}
          onSignOut={onSignOut}
        />
        <div className="mt-4 sm:mt-6">
          {tab === "summary" && (
            <SummaryPage
              transactions={transactions}
              accounts={accounts}
              goal={goal}
              setGoal={setGoal}
              period={period}
              setPeriod={setPeriod}
              selectedMonth={selectedMonth || availableMonths[availableMonths.length - 1]}
              setSelectedMonth={setSelectedMonth}
              availableMonths={availableMonths}
              updateAccountOpening={updateAccountOpening}
              addAccount={addAccount}
              rates={rates}
              fetchRates={fetchRates}
            />
          )}
          {tab === "income" && (
            <TransactionsPage
              type="income"
              title="Доходы"
              categories={INCOME_CATS}
              accounts={accounts.filter((a) => TRANSACTABLE_TYPES.includes(a.type))}
              transactions={transactions.filter((t) => t.type === "income")}
              addTransaction={addTransaction}
              deleteTransaction={deleteTransaction}
              rates={rates}
            />
          )}
          {tab === "expense" && (
            <TransactionsPage
              type="expense"
              title="Расходы"
              categories={EXPENSE_CATS}
              accounts={accounts.filter((a) => TRANSACTABLE_TYPES.includes(a.type))}
              transactions={transactions.filter((t) => t.type === "expense")}
              addTransaction={addTransaction}
              deleteTransaction={deleteTransaction}
              rates={rates}
            />
          )}
          {tab === "transfer" && (
            <TransferPage
              accounts={accounts}
              transactions={transactions.filter((t) => t.type === "transfer")}
              addTransaction={addTransaction}
              deleteTransaction={deleteTransaction}
              rates={rates}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top navigation
// ---------------------------------------------------------------------------
function TopNav({ tab, setTab, period, setPeriod, selectedMonth, setSelectedMonth, availableMonths, currentCapital, capitalDelta, activeTypeStats, exportData, importData, userEmail, onSignOut }) {
  const items = [
    { id: "summary", label: "Сводка", icon: LayoutGrid },
    { id: "income", label: "Доходы", icon: ArrowUpCircle },
    { id: "expense", label: "Расходы", icon: ArrowDownCircle },
    { id: "transfer", label: "Капитал", icon: PiggyBank },
  ];
  const typeColor = tab === "income" ? COLORS.green : tab === "expense" ? COLORS.red : COLORS.violet;
  const fileInputRef = useRef(null);
  return (
    <div className="flex flex-col items-center gap-3 lg:relative lg:flex-row lg:items-center lg:justify-between lg:flex-wrap">
      <div className="flex items-center flex-wrap justify-center gap-2">
        <div className="flex items-center gap-2 mr-1 sm:mr-4">
          <div className="flex items-center justify-center rounded-xl shrink-0" style={{ width: 34, height: 34, background: COLORS.blue }}>
            <Wallet size={18} color="#fff" />
          </div>
        </div>
        <div className="flex gap-1 p-1 rounded-xl" style={{ background: "#EDEEF1" }}>
          {items.map((it) => {
            const active = tab === it.id;
            return (
              <button
                key={it.id}
                onClick={() => setTab(it.id)}
                title={it.label}
                aria-label={it.label}
                className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors focus:outline-none"
                style={{
                  background: active ? "#fff" : "transparent",
                  color: active ? COLORS.text : COLORS.sub,
                  boxShadow: active ? "0 1px 2px rgba(16,24,40,0.08)" : "none",
                }}
              >
                <it.icon size={17} />
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1 ml-1 sm:ml-2">
          <button
            onClick={exportData}
            title="Скачать резервную копию (JSON)"
            aria-label="Экспорт данных"
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors focus:outline-none"
            style={{ color: COLORS.sub }}
          >
            <Download size={16} />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            title="Загрузить резервную копию (JSON)"
            aria-label="Импорт данных"
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors focus:outline-none"
            style={{ color: COLORS.sub }}
          >
            <Upload size={16} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importData(file);
              e.target.value = "";
            }}
          />
          <button
            onClick={onSignOut}
            title="Выйти из аккаунта"
            aria-label="Выйти"
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors focus:outline-none"
            style={{ color: COLORS.sub }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>

      {tab === "summary" && (
        <span className="flex items-baseline gap-2 lg:absolute lg:left-1/2 lg:-translate-x-1/2">
          <span className="text-lg font-bold tabular-nums">{fmtRub(currentCapital)}</span>
          <Delta value={capitalDelta} isPct favorable={true} />
        </span>
      )}

      {(tab === "income" || tab === "expense" || tab === "transfer") && (
        <span className="text-sm font-medium text-center lg:absolute lg:left-1/2 lg:-translate-x-1/2" style={{ color: COLORS.sub }}>
          {activeTypeStats.count} {tab === "income" ? "операций дохода" : tab === "expense" ? "операций расхода" : "переводов"}
        </span>
      )}

      {tab === "summary" && (
        <div className="flex items-center gap-2 flex-wrap justify-center">
          <div className="flex gap-1 p-1 rounded-lg" style={{ background: "#EDEEF1" }}>
            {[["month", "Месяц"], ["half", "Полгода"], ["year", "Год"]].map(([id, lbl]) => (
              <button
                key={id}
                onClick={() => setPeriod(id)}
                className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors focus:outline-none"
                style={{
                  background: period === id ? "#fff" : "transparent",
                  color: period === id ? COLORS.text : COLORS.sub,
                  boxShadow: period === id ? "0 1px 2px rgba(16,24,40,0.08)" : "none",
                }}
              >
                {lbl}
              </button>
            ))}
          </div>
          <div className="relative">
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(e.target.value)}
              className="appearance-none pl-3 pr-9 py-2 rounded-lg text-sm font-medium cursor-pointer"
              style={{ background: COLORS.card, border: `1px solid ${COLORS.border}` }}
            >
              {availableMonths.map((k) => (
                <option key={k} value={k}>{monthLabel(k)}</option>
              ))}
            </select>
            <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2" style={{ color: COLORS.sub }} />
          </div>
        </div>
      )}

      {(tab === "income" || tab === "expense" || tab === "transfer") && (
        <div className="flex items-baseline gap-2">
          <span className="text-xs" style={{ color: COLORS.sub }}>Итого</span>
          <span className="text-lg font-bold tabular-nums" style={{ color: typeColor }}>{fmtRub(activeTypeStats.total)}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary page
// ---------------------------------------------------------------------------
function SummaryPage({ transactions, accounts, goal, setGoal, period, setPeriod, selectedMonth, setSelectedMonth, updateAccountOpening, addAccount, rates, fetchRates }) {
  const periodN = period === "month" ? 1 : period === "half" ? 6 : 12;
  const periodLabel = period === "month" ? "за месяц" : period === "half" ? "за полгода" : "за год";

  const income = transactions.filter((t) => t.type === "income");
  const expense = transactions.filter((t) => t.type === "expense");

  const accountByName = useMemo(() => Object.fromEntries(accounts.map((a) => [a.name, a])), [accounts]);
  // сумма списка операций в рублях — каждая операция конвертируется по валюте
  // её собственного счёта (для рублёвых счетов toRub просто возвращает как есть)
  const sumBy = (list, pred) => list.filter(pred).reduce((s, t) => {
    const code = accountCurrency(accountByName[t.account]);
    return s + toRub(t.amount, code, rates);
  }, 0);

  const periodKeysArr = (endKey, n) => Array.from({ length: n }, (_, i) => addMonths(endKey, -(n - 1 - i)));

  const capitalAtEnd = useCallback((mKeyArg) => {
    // capital = sum(opening) + income up to end of month - expense up to end of month, всё в рублях
    const endStr = mKeyArg + "-31"; // string compare works since ISO dates, day overshoot is fine for "<="
    return accounts.reduce((s, a) => {
      const code = accountCurrency(a);
      const openingRub = toRub(a.opening, code, rates);
      const inc = income.filter((t) => t.account === a.name && t.date <= endStr).reduce((sum, t) => sum + toRub(t.amount, code, rates), 0);
      const exp = expense.filter((t) => t.account === a.name && t.date <= endStr).reduce((sum, t) => sum + toRub(t.amount, code, rates), 0);
      return s + openingRub + inc - exp;
    }, 0);
  }, [accounts, income, expense, rates.usd, rates.eur]);

  const availableMonths = useMemo(() => {
    const set = new Set(transactions.map((t) => monthKey(t.date)));
    set.add(selectedMonth || todayKey());
    return Array.from(set).sort();
  }, [transactions, selectedMonth]);

  const mKey = selectedMonth || availableMonths[availableMonths.length - 1];

  const curKeys = periodKeysArr(mKey, periodN);
  const prevPeriodEndKey = addMonths(mKey, -periodN);
  const prevKeys = periodKeysArr(prevPeriodEndKey, periodN);

  const periodIncome = sumBy(income, (t) => curKeys.includes(monthKey(t.date)));
  const periodExpense = sumBy(expense, (t) => curKeys.includes(monthKey(t.date)));
  const prevPeriodIncome = sumBy(income, (t) => prevKeys.includes(monthKey(t.date)));
  const prevPeriodExpense = sumBy(expense, (t) => prevKeys.includes(monthKey(t.date)));

  const capital = capitalAtEnd(mKey);
  const capitalBeforePeriod = capitalAtEnd(prevPeriodEndKey);
  const netIncome = periodIncome - periodExpense;
  const prevNetIncome = prevPeriodIncome - prevPeriodExpense;
  const savingsRate = periodIncome ? netIncome / periodIncome : 0;
  const prevSavingsRate = prevPeriodIncome ? prevNetIncome / prevPeriodIncome : 0;

  // current (as-of-now) account balances, independent of selected month.
  // Считаем в НАТИВНОЙ валюте счёта (для "Валюта"-счетов — в долларах/евро),
  // а перевод из другой валюты по дороге переводится через рубли по курсу ЦБ.
  const transfers = transactions.filter((t) => t.type === "transfer");
  const nativeSum = (list, name, field) => list.filter((t) => t[field] === name).reduce((s, t) => s + (Number(t.amount) || 0), 0);
  const transferInNative = (acc) => transfers.filter((t) => t.toAccount === acc.name).reduce((s, t) => {
    const fromAcc = accountByName[t.fromAccount];
    const fromCode = accountCurrency(fromAcc);
    const toCode = accountCurrency(acc);
    if (fromCode === toCode) return s + (Number(t.amount) || 0);
    const rub = toRub(t.amount, fromCode, rates);
    const r = rateForCurrency(toCode, rates);
    return s + (toCode === "RUB" ? rub : r ? rub / r : 0);
  }, 0);
  const accountBalance = (acc) => {
    const inc = nativeSum(income, acc.name, "account");
    const exp = nativeSum(expense, acc.name, "account");
    const transferIn = transferInNative(acc);
    const transferOut = nativeSum(transfers, acc.name, "fromAccount");
    return Number(acc.opening || 0) + inc - exp + transferIn - transferOut; // в валюте счёта
  };
  const balances = accounts.map((a) => {
    const code = accountCurrency(a);
    const nativeBalance = accountBalance(a);
    return { ...a, nativeBalance, currencyCode: code, balance: toRub(nativeBalance, code, rates) };
  });
  const currentCapital = balances.reduce((s, a) => s + a.balance, 0);

  const distribution = ACCOUNT_TYPES.map((type) => {
    const sum = balances.filter((a) => a.type === type).reduce((s, a) => s + a.balance, 0);
    return { type, sum, pct: currentCapital ? sum / currentCapital : 0 };
  });

  // history for line chart: from earliest tx month (or 6 months back) to selected month, capped at 13 points
  const history = useMemo(() => {
    const allKeys = transactions.map((t) => monthKey(t.date)).sort();
    const startKey = allKeys.length ? allKeys[0] : addMonths(mKey, -6);
    const points = [];
    let k = startKey;
    let guard = 0;
    while (k <= mKey && guard < 36) {
      points.push({ key: k, label: monthLabel(k), capital: capitalAtEnd(k) });
      k = addMonths(k, 1);
      guard++;
    }
    return points.slice(-13);
  }, [transactions, mKey, capitalAtEnd]);

  // monthly stats for best/worst/average (only months that actually have transactions)
  const monthKeysWithData = Array.from(new Set(transactions.map((t) => monthKey(t.date)))).sort();
  const monthStats = monthKeysWithData.map((k) => ({
    key: k,
    income: sumBy(income, (t) => monthKey(t.date) === k),
    expense: sumBy(expense, (t) => monthKey(t.date) === k),
  })).map((m) => ({ ...m, net: m.income - m.expense }));
  const bestMonth = monthStats.length ? monthStats.reduce((a, b) => (b.net > a.net ? b : a)) : null;
  const worstMonth = monthStats.length ? monthStats.reduce((a, b) => (b.net < a.net ? b : a)) : null;
  const avgIncome = monthStats.length ? monthStats.reduce((s, m) => s + m.income, 0) / monthStats.length : 0;
  const avgExpense = monthStats.length ? monthStats.reduce((s, m) => s + m.expense, 0) / monthStats.length : 0;

  const recent = useMemo(() => {
    return [...transactions].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 8);
  }, [transactions]);

  // safe % change: falls back to 0/100% instead of disappearing when the comparison period has no data
  const pctChange = (cur, prev) => {
    if (prev) return (cur - prev) / Math.abs(prev);
    return cur ? 1 : 0;
  };

  const kpis = [
    { label: `Доходы (${periodLabel})`, value: periodIncome, delta: periodIncome - prevPeriodIncome, deltaPct: pctChange(periodIncome, prevPeriodIncome), icon: TrendingUp, fg: COLORS.green, bg: COLORS.greenBg, favorable: true },
    { label: `Расходы (${periodLabel})`, value: periodExpense, delta: periodExpense - prevPeriodExpense, deltaPct: pctChange(periodExpense, prevPeriodExpense), icon: TrendingDown, fg: COLORS.red, bg: COLORS.redBg, favorable: false },
    { label: `Сбережения (${periodLabel})`, value: netIncome, delta: netIncome - prevNetIncome, deltaPct: pctChange(netIncome, prevNetIncome), icon: PiggyBank, fg: COLORS.violet, bg: COLORS.violetBg, favorable: true },
    { label: "Норма сбережений", value: savingsRate, isPct: true, delta: savingsRate - prevSavingsRate, deltaPct: null, icon: Target, fg: COLORS.amber, bg: COLORS.amberBg, favorable: true },
  ];

  return (
    <div className="space-y-6">
      {/* компактная строка: лучший/худший месяц, средние доход/расход */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatBlock label="Лучший месяц" value={bestMonth ? monthLabel(bestMonth.key) : "—"} sub={bestMonth ? fmtRubSigned(bestMonth.net) : ""} color={COLORS.green} icon={TrendingUp} />
        <StatBlock label="Худший месяц" value={worstMonth ? monthLabel(worstMonth.key) : "—"} sub={worstMonth ? fmtRubSigned(worstMonth.net) : ""} color={COLORS.red} icon={TrendingDown} />
        <StatBlock label="Средний доход/мес" value={fmtRub(avgIncome)} color={COLORS.blue} icon={ArrowUpCircle} />
        <StatBlock label="Средний расход/мес" value={fmtRub(avgExpense)} color={COLORS.amber} icon={ArrowDownCircle} />
      </div>

      {/* KPI cards (compact) + recent transactions */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="grid grid-cols-2 gap-3">
          {kpis.map((k) => (
            <Card key={k.label} style={{ padding: 12 }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium" style={{ color: COLORS.sub }}>{k.label}</span>
                <IconBadge icon={k.icon} fg={k.fg} bg={k.bg} size={26} />
              </div>
              <div className="text-base font-bold tabular-nums">{k.isPct ? fmtPctPlain(k.value) : fmtRub(k.value)}</div>
              <div className="mt-0.5">
                <Delta value={k.isPct ? k.delta : k.deltaPct} isPct favorable={k.favorable} />
              </div>
            </Card>
          ))}
        </div>

        <Card style={{ padding: 16 }}>
          <div className="text-sm font-semibold mb-3">Последние операции</div>
          <div className="space-y-1">
            {recent.length === 0 && <div className="text-sm" style={{ color: COLORS.sub }}>Пока нет операций.</div>}
            {recent.slice(0, 6).map((t) => (
              <div key={t.id} className="flex items-center justify-between py-1.5" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                <div className="min-w-0">
                  <div className="text-xs" style={{ color: COLORS.sub }}>{new Date(t.date).toLocaleDateString("ru-RU")} · {t.category}</div>
                  <div className="truncate text-xs" style={{ color: COLORS.sub }}>{t.description || "—"}</div>
                </div>
                <span className="font-medium tabular-nums shrink-0 ml-2 text-sm" style={{ color: t.type === "income" ? COLORS.green : COLORS.red }}>
                  {t.type === "income" ? "+" : "-"}{fmtRub(t.amount)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* динамика + активы по типам — один ряд */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <Card style={{ padding: 20 }}>
          <div className="text-sm font-semibold mb-2">Динамика капитала</div>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: COLORS.sub }} axisLine={{ stroke: COLORS.border }} tickLine={false} />
                <YAxis
                  tick={<YAxisTickLeft />}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={fmtCompact}
                  width={54}
                />
                <Tooltip formatter={(v) => fmtRub(v)} contentStyle={{ borderRadius: 10, border: `1px solid ${COLORS.border}`, fontSize: 12 }} />
                <Line type="monotone" dataKey="capital" stroke={COLORS.green} strokeWidth={2.5} dot={{ r: 3, fill: COLORS.green }} activeDot={{ r: 5 }} name="Капитал" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card style={{ padding: 20 }}>
          <div className="text-sm font-semibold mb-2">Активы по типам</div>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={distribution.filter((d) => d.type !== "Долг/кредит" && d.sum > 0)}
                  dataKey="sum" nameKey="type" innerRadius={50} outerRadius={75} paddingAngle={2}
                  isAnimationActive={false}
                >
                  {distribution.filter((d) => d.type !== "Долг/кредит" && d.sum > 0).map((d) => (
                    <Cell key={d.type} fill={TYPE_COLOR[d.type]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => fmtRub(v)} contentStyle={{ borderRadius: 10, border: `1px solid ${COLORS.border}`, fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* мои счета */}
      <Card style={{ padding: 20 }}>
        <div className="text-sm font-semibold mb-3">Мои счета</div>
        {accounts.some((a) => a.type === "Валюта") && (
          <div className="flex items-center flex-wrap gap-x-5 gap-y-1.5 text-sm px-3 py-2.5 rounded-lg mb-3" style={{ background: COLORS.bg }}>
            <span className="flex items-center gap-1.5">
              <span className="text-xs" style={{ color: COLORS.sub }}>USD</span>
              <span className="font-semibold tabular-nums">{rates.usd ? fmtRateRub(rates.usd) : "—"}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-xs" style={{ color: COLORS.sub }}>EUR</span>
              <span className="font-semibold tabular-nums">{rates.eur ? fmtRateRub(rates.eur) : "—"}</span>
            </span>
            <span className="text-xs" style={{ color: COLORS.sub }}>
              {rates.error
                ? rates.error
                : rates.updatedAt
                ? `Курс ЦБ РФ на ${new Date(rates.updatedAt).toLocaleDateString("ru-RU")}`
                : "Загрузка курса…"}
            </span>
            <button
              onClick={fetchRates}
              disabled={rates.loading}
              className="flex items-center gap-1 text-xs font-medium focus:outline-none ml-auto"
              style={{ color: COLORS.blue }}
              title="Обновить курс"
            >
              <RefreshCw size={12} className={rates.loading ? "animate-spin" : ""} />
              Обновить
            </button>
          </div>
        )}
        {balances.length === 0 && (
          <div className="text-sm mb-2" style={{ color: COLORS.sub }}>Пока нет ни одного счёта — добавьте первый ниже.</div>
        )}
        <div>
          {balances.map((a) => {
            const isCur = a.currencyCode !== "RUB";
            return (
              <div key={a.id} className="grid grid-cols-2 items-center gap-x-2 gap-y-1.5 py-2.5 text-sm group sm:grid-cols-[1fr_120px_100px_140px] sm:gap-2 sm:py-1.5" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                <div className="flex items-center gap-2 min-w-0 col-span-2 sm:col-span-1">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: TYPE_COLOR[a.type] }} />
                  <span className="truncate font-medium">{a.name}</span>
                  {isCur && <span className="text-xs shrink-0" style={{ color: COLORS.sub }}>({a.currencyCode})</span>}
                </div>
                <span className="text-xs" style={{ color: COLORS.sub }}>
                  {isCur ? `Начальный остаток, ${CURRENCY_SYMBOL[a.currencyCode]}` : "Начальный остаток"}
                </span>
                <input
                  type="number"
                  value={a.opening}
                  onChange={(e) => updateAccountOpening(a.id, e.target.value)}
                  className="px-2 py-1 rounded-md text-sm w-full text-right"
                  style={{ border: `1px solid ${COLORS.border}` }}
                />
                <div className="text-right col-span-2 sm:col-span-1">
                  <div className="font-semibold tabular-nums">{isCur ? fmtCur(a.nativeBalance, a.currencyCode) : fmtRub(a.balance)}</div>
                  {isCur && <div className="text-xs tabular-nums" style={{ color: COLORS.sub }}>≈ {fmtRub(a.balance)}</div>}
                </div>
              </div>
            );
          })}
        </div>
        <AddAccountForm onAdd={addAccount} />
      </Card>


      {/* goal */}
      <Card style={{ padding: 20 }}>
        <div className="text-sm font-semibold mb-3">Цель по капиталу</div>
        <div className="flex items-center gap-4 sm:gap-8 flex-wrap">
          <div>
            <div className="text-xs mb-1" style={{ color: COLORS.sub }}>Финансовая свобода</div>
            <input
              type="number"
              value={goal}
              onChange={(e) => setGoal(Number(e.target.value))}
              className="text-lg font-bold px-2 py-1 rounded-md tabular-nums"
              style={{ border: `1px solid ${COLORS.border}`, width: 160 }}
            />
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: COLORS.sub }}>Накоплено</div>
            <div className="text-lg font-bold tabular-nums">{fmtRub(currentCapital)}</div>
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div className="h-2 rounded-full overflow-hidden mb-1.5" style={{ background: "#EDEEF1" }}>
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, (currentCapital / goal) * 100))}%`, background: COLORS.green }} />
            </div>
            <div className="flex items-center justify-between text-xs" style={{ color: COLORS.sub }}>
              <span>{fmtPctPlain(goal ? currentCapital / goal : 0)}</span>
              <span>Осталось {fmtRub(Math.max(0, goal - currentCapital))}</span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function StatBlock({ label, value, sub, color, icon: Icon }) {
  return (
    <Card style={{ padding: "10px 12px" }} className="flex items-center gap-2.5">
      <IconBadge icon={Icon} fg={color} bg={color + "1A"} size={30} />
      <div className="min-w-0">
        <div className="text-[11px] leading-tight" style={{ color: COLORS.sub }}>{label}</div>
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <div className="text-sm font-semibold truncate">{value}</div>
          {sub && <div className="text-[11px] font-medium shrink-0" style={{ color }}>{sub}</div>}
        </div>
      </div>
    </Card>
  );
}

function AddAccountForm({ onAdd }) {
  const [name, setName] = useState("");
  const [type, setType] = useState(ACCOUNT_TYPES[0]);
  const [currency, setCurrency] = useState("USD");
  const [opening, setOpening] = useState(0);
  const isCur = type === "Валюта";
  const submit = () => {
    if (!name.trim()) return;
    onAdd({ name: name.trim(), type, opening: Number(opening), ...(isCur ? { currency } : {}) });
    setName(""); setOpening(0);
  };
  return (
    <div className="flex flex-col gap-2 mt-3 pt-3 sm:flex-row sm:items-center sm:flex-wrap" style={{ borderTop: `1px solid ${COLORS.border}` }}>
      <input placeholder="Название счёта" value={name} onChange={(e) => setName(e.target.value)}
        className="px-2 py-1.5 rounded-md text-sm w-full sm:flex-1" style={{ border: `1px solid ${COLORS.border}`, minWidth: 120 }} />
      <div className="flex gap-2">
        <select value={type} onChange={(e) => setType(e.target.value)} className="px-2 py-1.5 rounded-md text-sm flex-1 sm:flex-none" style={{ border: `1px solid ${COLORS.border}` }}>
          {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {isCur && (
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="px-2 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${COLORS.border}` }}>
            {CURRENCY_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>
      <input type="number" placeholder={isCur ? `Остаток, ${CURRENCY_SYMBOL[currency]}` : "Остаток, ₽"} value={opening} onChange={(e) => setOpening(e.target.value)}
        className="px-2 py-1.5 rounded-md text-sm w-full sm:w-32" style={{ border: `1px solid ${COLORS.border}` }} />
      <button onClick={submit} className="flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium text-white focus:outline-none w-full sm:w-auto" style={{ background: COLORS.blue }}>
        <Plus size={14} /> Добавить счёт
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Income / Expense page (shared component)
// ---------------------------------------------------------------------------
function TransactionsPage({ type, title, categories, accounts, transactions, addTransaction, deleteTransaction, rates }) {
  const isIncome = type === "income";
  const [date, setDate] = useState(todayStr());
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [account, setAccount] = useState(accounts[0]?.name || "");

  const listId = `${type}-categories`;
  const accountByName = useMemo(() => Object.fromEntries(accounts.map((a) => [a.name, a])), [accounts]);
  const selectedCode = accountCurrency(accountByName[account]);
  const isCurAccount = selectedCode !== "RUB";

  const sorted = useMemo(() => [...transactions].sort((a, b) => (a.date < b.date ? 1 : -1)), [transactions]);
  // сумма списка в рублях — операции по валютным счетам конвертируются по курсу ЦБ
  const total = transactions.reduce((s, t) => s + toRub(t.amount, accountCurrency(accountByName[t.account]), rates), 0);

  const submit = () => {
    if (!date || !category.trim() || !amount || Number(amount) <= 0) return;
    addTransaction({ date, category: category.trim(), description: description.trim(), amount: Number(amount), account, type });
    setCategory(""); setDescription(""); setAmount("");
  };

  const color = isIncome ? COLORS.green : COLORS.red;
  const bg = isIncome ? COLORS.greenBg : COLORS.redBg;

  return (
    <div className="space-y-5">
      <Card style={{ padding: 16 }}>
        <div className="grid grid-cols-1 gap-2 items-end sm:grid-cols-2">
          <Field label="Категория">
            <input list={listId} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Выберите или впишите"
              className="w-full px-2 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${COLORS.border}` }} />
            <datalist id={listId}>{categories.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Счёт">
            <select value={account} onChange={(e) => setAccount(e.target.value)}
              className="w-full px-2 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${COLORS.border}` }}>
              {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
          </Field>
          <Field label={isCurAccount ? `Сумма, ${CURRENCY_SYMBOL[selectedCode]}` : "Сумма, ₽"}>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0"
              className="w-full px-2 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${COLORS.border}` }} />
            {isCurAccount && amount && (
              <div className="text-xs mt-1" style={{ color: COLORS.sub }}>≈ {fmtRub(toRub(amount, selectedCode, rates))}</div>
            )}
          </Field>
          <Field label="Дата">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="w-full px-2 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${COLORS.border}` }} />
          </Field>
          <Field label="Описание" className="sm:col-span-2">
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Необязательно"
              className="w-full px-2 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${COLORS.border}` }} />
          </Field>
        </div>
        <button onClick={submit} className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white mt-3 focus:outline-none w-full sm:w-auto" style={{ background: color }}>
          <Plus size={15} /> Добавить
        </button>
      </Card>

      <Card style={{ padding: 0 }}>
        <div className="hidden sm:grid gap-2 px-4 py-2.5 text-xs font-semibold" style={{ gridTemplateColumns: "90px 1fr 1.4fr 110px 110px 36px", color: COLORS.sub, borderBottom: `1px solid ${COLORS.border}` }}>
          <span>Дата</span><span>Категория</span><span>Описание</span><span>Счёт</span><span className="text-right">Сумма</span><span />
        </div>
        {sorted.length === 0 && (
          <div className="px-4 py-8 text-center text-sm" style={{ color: COLORS.sub }}>Пока нет операций — добавьте первую выше.</div>
        )}
        {sorted.map((t) => {
          const tCode = accountCurrency(accountByName[t.account]);
          const tIsCur = tCode !== "RUB";
          return (
          <div key={t.id}>
            {/* мобильная карточка операции */}
            <div className="sm:hidden flex items-start justify-between gap-3 px-4 py-3 group" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-xs px-2 py-0.5 rounded-full" style={{ color, background: bg }}>{t.category}</span>
                  <span className="text-xs" style={{ color: COLORS.sub }}>{new Date(t.date).toLocaleDateString("ru-RU")}</span>
                </div>
                <div className="truncate text-xs" style={{ color: COLORS.sub }}>{t.account}{t.description ? ` · ${t.description}` : ""}</div>
              </div>
              <div className="flex items-start gap-2 shrink-0">
                <div className="text-right">
                  <div className="font-medium tabular-nums text-sm" style={{ color }}>
                    {tIsCur ? fmtCur(t.amount, tCode) : fmtRub(t.amount)}
                  </div>
                  {tIsCur && <div className="text-xs font-normal" style={{ color: COLORS.sub }}>≈ {fmtRub(toRub(t.amount, tCode, rates))}</div>}
                </div>
                <button onClick={() => deleteTransaction(t.id)} className="focus:outline-none mt-0.5" style={{ color: COLORS.sub }}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            {/* десктопная строка-таблица */}
            <div className="hidden sm:grid gap-2 px-4 py-2.5 text-sm items-center group" style={{ gridTemplateColumns: "90px 1fr 1.4fr 110px 110px 36px", borderBottom: `1px solid ${COLORS.border}` }}>
              <span style={{ color: COLORS.sub }}>{new Date(t.date).toLocaleDateString("ru-RU")}</span>
              <span>
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ color, background: bg }}>{t.category}</span>
              </span>
              <span className="truncate" style={{ color: COLORS.sub }}>{t.description || "—"}</span>
              <span className="truncate" style={{ color: COLORS.sub }}>{t.account}</span>
              <span className="text-right font-medium tabular-nums" style={{ color }}>
                {tIsCur ? fmtCur(t.amount, tCode) : fmtRub(t.amount)}
                {tIsCur && <div className="text-xs font-normal" style={{ color: COLORS.sub }}>≈ {fmtRub(toRub(t.amount, tCode, rates))}</div>}
              </span>
              <button onClick={() => deleteTransaction(t.id)} className="opacity-0 group-hover:opacity-100 justify-self-end focus:outline-none" style={{ color: COLORS.sub }}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          );
        })}
      </Card>
    </div>
  );
}

function Field({ label, children, className = "" }) {
  return (
    <div className={className}>
      <div className="text-xs mb-1" style={{ color: COLORS.sub }}>{label}</div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transfer page — переброска денег между счетами (пополнение капитала:
// накопительный счёт, депозит, акции, ОФЗ и т.п.). Не влияет на доходы/расходы.
// ---------------------------------------------------------------------------
function TransferPage({ accounts, transactions, addTransaction, deleteTransaction, rates }) {
  const [date, setDate] = useState(todayStr());
  const [fromAccount, setFromAccount] = useState(accounts[0]?.name || "");
  const [toAccount, setToAccount] = useState(accounts[1]?.name || accounts[0]?.name || "");
  const [amount, setAmount] = useState("");

  const accountByName = useMemo(() => Object.fromEntries(accounts.map((a) => [a.name, a])), [accounts]);
  const fromCode = accountCurrency(accountByName[fromAccount]);
  const toCode = accountCurrency(accountByName[toAccount]);
  const isCurFrom = fromCode !== "RUB";
  const crossCurrency = fromCode !== toCode;

  const sorted = useMemo(() => [...transactions].sort((a, b) => (a.date < b.date ? 1 : -1)), [transactions]);

  // сумма перевода вводится и хранится в валюте счёта-источника (fromAccount);
  // если счёт-получатель в другой валюте, конвертация происходит при подсчёте баланса
  const submit = () => {
    if (!date || !fromAccount || !toAccount || fromAccount === toAccount || !amount || Number(amount) <= 0) return;
    addTransaction({ date, fromAccount, toAccount, amount: Number(amount), type: "transfer" });
    setAmount("");
  };

  // во сколько единиц валюты счёта-получателя превратится сумма — для превью при разных валютах
  const convertedPreview = useMemo(() => {
    if (!crossCurrency || !amount) return null;
    const rub = toRub(amount, fromCode, rates);
    if (toCode === "RUB") return fmtRub(rub);
    const r = rateForCurrency(toCode, rates);
    return r ? fmtCur(rub / r, toCode) : null;
  }, [crossCurrency, amount, fromCode, toCode, rates]);

  return (
    <div className="space-y-5">
      <Card style={{ padding: 16 }}>
        <div className="grid grid-cols-1 gap-2 items-end sm:grid-cols-2">
          <Field label="Со счёта">
            <select value={fromAccount} onChange={(e) => setFromAccount(e.target.value)}
              className="w-full px-2 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${COLORS.border}` }}>
              {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="На счёт">
            <select value={toAccount} onChange={(e) => setToAccount(e.target.value)}
              className="w-full px-2 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${COLORS.border}` }}>
              {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
          </Field>
          <Field label={isCurFrom ? `Сумма, ${CURRENCY_SYMBOL[fromCode]}` : "Сумма, ₽"}>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0"
              className="w-full px-2 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${COLORS.border}` }} />
            {convertedPreview && (
              <div className="text-xs mt-1" style={{ color: COLORS.sub }}>≈ {convertedPreview} на счёте получателя</div>
            )}
          </Field>
          <Field label="Дата">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="w-full px-2 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${COLORS.border}` }} />
          </Field>
        </div>
        <button onClick={submit} className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white mt-3 focus:outline-none w-full sm:w-auto" style={{ background: COLORS.violet }}>
          <Plus size={15} /> Добавить
        </button>
      </Card>

      <Card style={{ padding: 0 }}>
        <div className="hidden sm:grid gap-2 px-4 py-2.5 text-xs font-semibold" style={{ gridTemplateColumns: "90px 1fr 1fr 110px 36px", color: COLORS.sub, borderBottom: `1px solid ${COLORS.border}` }}>
          <span>Дата</span><span>Со счёта</span><span>На счёт</span><span className="text-right">Сумма</span><span />
        </div>
        {sorted.length === 0 && (
          <div className="px-4 py-8 text-center text-sm" style={{ color: COLORS.sub }}>Пока нет переводов — добавьте первый выше.</div>
        )}
        {sorted.map((t) => {
          const tCode = accountCurrency(accountByName[t.fromAccount]);
          const tIsCur = tCode !== "RUB";
          return (
          <div key={t.id}>
            {/* мобильная карточка перевода */}
            <div className="sm:hidden flex items-start justify-between gap-3 px-4 py-3 group" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
              <div className="min-w-0">
                <div className="text-xs mb-1" style={{ color: COLORS.sub }}>{new Date(t.date).toLocaleDateString("ru-RU")}</div>
                <div className="text-sm truncate">{t.fromAccount} <span style={{ color: COLORS.sub }}>→</span> {t.toAccount}</div>
              </div>
              <div className="flex items-start gap-2 shrink-0">
                <div className="text-right">
                  <div className="font-medium tabular-nums text-sm" style={{ color: COLORS.violet }}>
                    {tIsCur ? fmtCur(t.amount, tCode) : fmtRub(t.amount)}
                  </div>
                  {tIsCur && <div className="text-xs font-normal" style={{ color: COLORS.sub }}>≈ {fmtRub(toRub(t.amount, tCode, rates))}</div>}
                </div>
                <button onClick={() => deleteTransaction(t.id)} className="focus:outline-none mt-0.5" style={{ color: COLORS.sub }}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            {/* десктопная строка-таблица */}
            <div className="hidden sm:grid gap-2 px-4 py-2.5 text-sm items-center group" style={{ gridTemplateColumns: "90px 1fr 1fr 110px 36px", borderBottom: `1px solid ${COLORS.border}` }}>
              <span style={{ color: COLORS.sub }}>{new Date(t.date).toLocaleDateString("ru-RU")}</span>
              <span className="truncate">{t.fromAccount}</span>
              <span className="truncate">{t.toAccount}</span>
              <span className="text-right font-medium tabular-nums" style={{ color: COLORS.violet }}>
                {tIsCur ? fmtCur(t.amount, tCode) : fmtRub(t.amount)}
                {tIsCur && <div className="text-xs font-normal" style={{ color: COLORS.sub }}>≈ {fmtRub(toRub(t.amount, tCode, rates))}</div>}
              </span>
              <button onClick={() => deleteTransaction(t.id)} className="opacity-0 group-hover:opacity-100 justify-self-end focus:outline-none" style={{ color: COLORS.sub }}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          );
        })}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth screen — email/пароль вход и регистрация. Firestore привязывает данные
// к user.uid, поэтому один и тот же аккаунт видит одни и те же данные с любого
// устройства (в отличие от прежнего localStorage, который был привязан к браузеру).
// ---------------------------------------------------------------------------
function AuthScreen() {
  const [mode, setMode] = useState("login"); // 'login' | 'register'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError("");
    if (!email.trim() || !password) { setError("Заполните почту и пароль"); return; }
    setBusy(true);
    try {
      if (mode === "login") {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      } else {
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (e) {
      const map = {
        "auth/invalid-email": "Некорректный email",
        "auth/user-not-found": "Пользователь не найден",
        "auth/wrong-password": "Неверный пароль",
        "auth/invalid-credential": "Неверная почта или пароль",
        "auth/email-already-in-use": "Этот email уже зарегистрирован",
        "auth/weak-password": "Пароль слишком короткий (минимум 6 символов)",
      };
      setError(map[e.code] || "Не удалось войти, попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-center" style={{ minHeight: "70vh" }}>
      <div className="w-full" style={{ maxWidth: 360 }}>
        <Card style={{ padding: 24 }}>
          <div className="flex items-center gap-2 mb-5">
            <div className="flex items-center justify-center rounded-xl" style={{ width: 34, height: 34, background: COLORS.blue }}>
              <Wallet size={18} color="#fff" />
            </div>
            <span className="text-base font-semibold">Капитал</span>
          </div>
          <div className="flex gap-1 p-1 rounded-lg mb-4" style={{ background: "#EDEEF1" }}>
            {[["login", "Войти"], ["register", "Регистрация"]].map(([id, lbl]) => (
              <button
                key={id}
                onClick={() => { setMode(id); setError(""); }}
                className="flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors focus:outline-none"
                style={{
                  background: mode === id ? "#fff" : "transparent",
                  color: mode === id ? COLORS.text : COLORS.sub,
                  boxShadow: mode === id ? "0 1px 2px rgba(16,24,40,0.08)" : "none",
                }}
              >
                {lbl}
              </button>
            ))}
          </div>
          <div className="space-y-3">
            <Field label="Email">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="you@example.com"
                className="w-full px-2 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${COLORS.border}` }} />
            </Field>
            <Field label="Пароль">
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="Минимум 6 символов"
                className="w-full px-2 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${COLORS.border}` }} />
            </Field>
            {error && <div className="text-xs" style={{ color: COLORS.red }}>{error}</div>}
            <button
              onClick={submit}
              disabled={busy}
              className="w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white mt-1 focus:outline-none"
              style={{ background: COLORS.blue, opacity: busy ? 0.6 : 1 }}
            >
              {busy ? "Подождите…" : mode === "login" ? "Войти" : "Создать аккаунт"}
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root component — следит за состоянием входа Firebase Auth и показывает
// либо экран входа, либо сам трекер (уже привязанный к конкретному аккаунту).
// ---------------------------------------------------------------------------
export default function CapitalTracker() {
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-64" style={{ color: COLORS.sub }}>
        Загрузка…
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  return (
    <TrackerApp
      userId={user.uid}
      userEmail={user.email}
      onSignOut={() => signOut(auth)}
    />
  );
}
