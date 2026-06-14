import { useState } from "react";

type Habit = { name: string; days: boolean[] };

const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

export default function HabitTracker() {
  const [habits, setHabits] = useState<Habit[]>([
    { name: "Read 20 min", days: [true, true, false, true, false, false, false] },
    { name: "Exercise", days: [true, false, true, false, true, false, false] },
    { name: "No doomscrolling", days: [false, true, true, true, false, false, false] },
  ]);
  const [draft, setDraft] = useState("");

  const toggle = (h: number, d: number) =>
    setHabits(hs => hs.map((x, i) => i === h ? { ...x, days: x.days.map((v, j) => j === d ? !v : v) } : x));

  const add = () => {
    if (!draft.trim()) return;
    setHabits(hs => [...hs, { name: draft.trim(), days: Array(7).fill(false) }]);
    setDraft("");
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-8 font-sans">
      <div className="max-w-xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Habit Tracker</h1>
        <p className="text-slate-400 mb-6 text-sm">A sample .tsx artifact — transpiled and rendered live by OpenArtifact.</p>
        <div className="space-y-3">
          {habits.map((h, hi) => {
            const done = h.days.filter(Boolean).length;
            return (
              <div key={hi} className="bg-slate-800 rounded-xl p-4 flex items-center gap-4">
                <div className="flex-1">
                  <div className="font-medium">{h.name}</div>
                  <div className="text-xs text-slate-400">{done}/7 this week</div>
                </div>
                <div className="flex gap-1.5">
                  {h.days.map((v, di) => (
                    <button
                      key={di}
                      onClick={() => toggle(hi, di)}
                      className={`w-8 h-8 rounded-lg text-xs font-semibold transition ${
                        v ? "bg-emerald-500 text-emerald-950" : "bg-slate-700 text-slate-400 hover:bg-slate-600"
                      }`}
                    >
                      {DAY_LABELS[di]}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-6 flex gap-2">
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => e.key === "Enter" && add()}
            placeholder="New habit…"
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-indigo-400"
          />
          <button onClick={add} className="bg-indigo-500 hover:bg-indigo-400 rounded-lg px-4 font-medium">Add</button>
        </div>
      </div>
    </div>
  );
}
