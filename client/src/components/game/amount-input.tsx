"use client";

type amount_input_props = {
  amount_sol: number;
  on_change: (value: number) => void;
};

const preset_amounts = [0.05, 0.1, 0.25, 0.5, 1, 2];

export const AmountInput = ({ amount_sol, on_change }: amount_input_props) => {
  const apply_value = (value: number) => {
    if (!Number.isFinite(value)) {
      on_change(0);
      return;
    }
    on_change(Math.max(0, Number(value.toFixed(4))));
  };

  return (
    <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-4">
      <label htmlFor="amount-sol" className="text-sm font-semibold text-slate-900">
        stake amount (SOL)
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="h-11 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          onClick={() => apply_value(amount_sol - 0.05)}
        >
          -0.05
        </button>
        <input
          id="amount-sol"
          type="number"
          min="0"
          step="0.01"
          value={Number.isFinite(amount_sol) ? amount_sol : 0}
          onChange={(event) => apply_value(Number(event.target.value || 0))}
          className="h-11 w-full rounded-xl border border-slate-300 px-3 text-sm outline-none ring-slate-900/20 transition focus:ring"
        />
        <button
          type="button"
          className="h-11 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          onClick={() => apply_value(amount_sol + 0.05)}
        >
          +0.05
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {preset_amounts.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => apply_value(preset)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
              amount_sol === preset
                ? "border-sky-300 bg-sky-50 text-sky-700"
                : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
            }`}
          >
            {preset.toFixed(2)} SOL
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">change amount any time before your next swipe.</p>
    </div>
  );
};
