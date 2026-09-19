import { createApp } from "https://mavue.mavo.io/mavue.js";

const ROOMMATES = [
  { id: "niara", name: "Ni'ara", key: "N" },
  { id: "amber", name: "Amber", key: "A" },
  { id: "arin", name: "Arin", key: "R" }, // "A" was taken by Amber
  { id: "khiara", name: "Khiara", key: "K" },
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isoMinusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function findByKey(key) {
  return ROOMMATES.find((r) => r.key.toUpperCase() === key.toUpperCase());
}

function parseQuickEntry(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return { ok: false, error: "Type something like: 150K groceries" };
  }

  const paymentToken = words[0];
  const segments = paymentToken.split("+");
  const payers = {};
  let currency = "BZD";

  for (const seg of segments) {
    const m = seg.match(/^(\d+(?:\.\d+)?)(BZD|MXN|GTQ)?([A-Za-z])$/i);
    if (!m) {
      return {
        ok: false,
        error: `Can't read "${seg}". Try an amount + a key from the legend, e.g. 150K.`,
      };
    }
    const [, amountStr, curr, key] = m;
    const person = findByKey(key);
    if (!person) {
      return { ok: false, error: `No roommate uses the key "${key.toUpperCase()}".` };
    }
    if (curr) currency = curr.toUpperCase();
    payers[person.id] = (payers[person.id] || 0) + parseFloat(amountStr);
  }

  let excludeIds = [];
  let daysAgo = 0;
  const descWords = [];

  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (/^-\d+$/.test(w)) {
      daysAgo = parseInt(w.slice(1), 10);
    } else if (/^-[A-Za-z]+$/.test(w)) {
      for (const letter of w.slice(1).toUpperCase().split("")) {
        const person = findByKey(letter);
        if (person) excludeIds.push(person.id);
      }
    } else {
      descWords.push(w);
    }
  }

  const splitAmong = ROOMMATES.map((r) => r.id).filter(
    (id) => !excludeIds.includes(id)
  );

  if (splitAmong.length === 0) {
    return { ok: false, error: "That excludes everyone \u2014 nobody would owe anything." };
  }

  return {
    ok: true,
    expense: {
      title: descWords.join(" ") || "(no description)",
      date: daysAgo ? isoMinusDays(daysAgo) : todayISO(),
      currency,
      payers,
      splitAmong,
    },
  };
}

/** Human-readable one-line preview of a parsed (but not yet saved) expense. */
function describeExpense(expense) {
  const payerNames = Object.entries(expense.payers)
    .map(([id, amt]) => {
      const name = ROOMMATES.find((r) => r.id === id)?.name ?? id;
      return `${name} ${amt}${expense.currency !== "BZD" ? " " + expense.currency : ""}`;
    })
    .join(" + ");

  let splitDesc;
  if (expense.splitCustom) {
    splitDesc = Object.entries(expense.splitCustom)
      .map(([id, amt]) => {
        const name = ROOMMATES.find((r) => r.id === id)?.name ?? id;
        return `${name} owes ${amt.toFixed(2)}`;
      })
      .join(", ");
  } else if (expense.splitAmong.length === Object.keys(expense.payers).length &&
             expense.splitAmong.every((id) => id in expense.payers)) {
    splitDesc = "no balance change (bookkeeping only)";
  } else if (expense.splitAmong.length === ROOMMATES.length) {
    splitDesc = "split among everyone";
  } else {
    const names = expense.splitAmong
      .map((id) => ROOMMATES.find((r) => r.id === id)?.name ?? id)
      .join(", ");
    splitDesc = `split among ${names}`;
  }

  return `${payerNames} \u2192 ${splitDesc} \u2014 ${expense.date}`;
}

globalThis.app = createApp(
  {
    data: {
      expenses: [],
      roommates: ROOMMATES,

      // Quick-entry state
      quickText: "",
      quickError: "",

      // Advanced entry / edit state
      showAdvanced: false,
      editingIndex: null, // null = adding new, otherwise index into expenses[]
      form: {
        title: "",
        date: todayISO(),
        currency: "BZD",
        payerAmounts: {}, // { roommateId: amountString }
        splitMode: "equal", // "equal" | "custom"
        splitWith: [], // roommate ids, used when splitMode === "equal"
        splitCustomAmounts: {}, // { roommateId: amountString }, used when splitMode === "custom"
      },
    },

    computed: {
      quickPreview() {
        if (!this.quickText.trim()) return "";
        const result = parseQuickEntry(this.quickText);
        if (!result.ok) {
          this.quickError = result.error;
          return "";
        }
        this.quickError = "";
        return describeExpense(result.expense);
      },

      /** Net balance per roommate, in BZD. Positive = owed to them, negative = they owe the house. */
      balances() {
        const bal = {};
        for (const r of this.roommates) bal[r.id] = 0;

        for (const exp of this.expenses) {
          const currency = exp.currency || "BZD";
          let totalBZD = 0;

          for (const [id, amt] of Object.entries(exp.payers || {})) {
            const bzd = this.currencyConvert(currency, "BZD", amt);
            bal[id] = (bal[id] ?? 0) + bzd;
            totalBZD += bzd;
          }

          if (exp.splitCustom) {
            for (const [id, share] of Object.entries(exp.splitCustom)) {
              bal[id] = (bal[id] ?? 0) - share;
            }
          } else if (exp.splitAmong && exp.splitAmong.length) {
            const share = totalBZD / exp.splitAmong.length;
            for (const id of exp.splitAmong) {
              bal[id] = (bal[id] ?? 0) - share;
            }
          }
        }
        return bal;
      },

      sortedExpenses() {
        return this.expenses
          .map((exp, index) => ({ exp, index }))
          .sort((a, b) => (a.exp.date < b.exp.date ? 1 : -1));
      },
    },

    methods: {

      currencyConvert(from, to, amount) {
        const rates = {
          BZD: 1,
          USD: 2
        };

        return (amount * rates[to]) / rates[from];
      },

      describeExpense,

      submitQuick() {
        const text = this.quickText.trim();
        if (!text) return;
        const result = parseQuickEntry(text);
        if (!result.ok) {
          this.quickError = result.error;
          return;
        }
        this.expenses = [...this.expenses, result.expense];
        this.quickText = "";
        this.quickError = "";
      },

      openAdvancedForNew() {
        this.editingIndex = null;
        this.form = {
          title: "",
          date: todayISO(),
          currency: "BZD",
          payerAmounts: {},
          splitMode: "equal",
          splitWith: this.roommates.map((r) => r.id),
          splitCustomAmounts: {},
        };
        this.showAdvanced = true;
      },

      openAdvancedForEdit(index) {
        const exp = this.expenses[index];
        this.editingIndex = index;
        const payerAmounts = {};
        for (const [id, amt] of Object.entries(exp.payers || {})) {
          payerAmounts[id] = String(amt);
        }
        const splitCustomAmounts = {};
        if (exp.splitCustom) {
          for (const [id, amt] of Object.entries(exp.splitCustom)) {
            splitCustomAmounts[id] = String(amt);
          }
        }
        this.form = {
          title: exp.title,
          date: exp.date,
          currency: exp.currency || "BZD",
          payerAmounts,
          splitMode: exp.splitCustom ? "custom" : "equal",
          splitWith: exp.splitAmong ? [...exp.splitAmong] : [],
          splitCustomAmounts,
        };
        this.showAdvanced = true;
      },

      cancelAdvanced() {
        this.showAdvanced = false;
        this.editingIndex = null;
      },

      submitAdvanced() {
        const payers = {};
        for (const [id, amtStr] of Object.entries(this.form.payerAmounts)) {
          const amt = parseFloat(amtStr);
          if (amt) payers[id] = amt;
        }

        if (Object.keys(payers).length === 0) {
          alert("At least one roommate needs to have paid something.");
          return;
        }

        const expense = {
          title: this.form.title.trim() || "(no description)",
          date: this.form.date || todayISO(),
          currency: this.form.currency,
          payers,
        };

        if (this.form.splitMode === "custom") {
          const splitCustom = {};
          for (const [id, amtStr] of Object.entries(this.form.splitCustomAmounts)) {
            const amt = parseFloat(amtStr);
            if (amt) splitCustom[id] = amt;
          }
          if (Object.keys(splitCustom).length === 0) {
            alert("Enter at least one custom split amount.");
            return;
          }
          expense.splitCustom = splitCustom;
        } else {
          if (this.form.splitWith.length === 0) {
            alert("Pick at least one roommate to split this among.");
            return;
          }
          expense.splitAmong = [...this.form.splitWith];
        }

        if (this.editingIndex === null) {
          this.expenses = [...this.expenses, expense];
        } else {
          const updated = [...this.expenses];
          updated[this.editingIndex] = expense;
          this.expenses = updated;
        }
        this.showAdvanced = false;
        this.editingIndex = null;
      },

      deleteExpense(index) {
        const exp = this.expenses[index];
        if (confirm(`Delete "${exp.title}"? This can't be undone.`)) {
          this.expenses = this.expenses.filter((_, i) => i !== index);
        }
      },
    },
  },
  "#app"
);
