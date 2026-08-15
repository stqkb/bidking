import type { WizardAction, WizardState } from "./wizardTypes";

const EMPTY_BOARD = () => Array.from({ length: 16 }, () => Array(16).fill(0));

export const initialState: WizardState = {
  step: 1,

  /* Step 1 */
  avg: "",
  countEst: "",
  advanced: false,
  redCount: "",
  redGrids: "",
  totalGrids: "",
  blueGrids: "",
  wgGrids: "",
  purpleGrids: "",
  goldGrids: "",
  minBid: "",
  margin: 0.84,
  useCalib: false,
  useBoard: false,
  board: EMPTY_BOARD(),

  /* Step 2 */
  knownItems: [{ key: 1, id: "", name: null, size: "", value: "" }],

  /* Step 3 */
  result: null,
  loading: false,
  error: "",
  lockedCand: null,
  lastInput: null,
  bidInput: "",
  saving: false,
  savedMsg: "",
};

export function estimateReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "NEXT_STEP":
      return { ...state, step: Math.min(3, state.step + 1) as 1 | 2 | 3, error: "" };

    case "PREV_STEP":
      return { ...state, step: Math.max(1, state.step - 1) as 1 | 2 | 3, error: "" };

    case "GO_STEP":
      return { ...state, step: action.step, error: "" };

    case "SET_FIELD":
      return { ...state, [action.field]: action.value };

    case "TOGGLE_ADVANCED":
      return { ...state, advanced: !state.advanced };

    case "ADD_KNOWN":
      return {
        ...state,
        knownItems: [...state.knownItems, { key: Date.now(), id: "", name: null, size: "", value: "" }],
      };

    case "REMOVE_KNOWN":
      if (state.knownItems.length <= 1) return state;
      return { ...state, knownItems: state.knownItems.filter((r) => r.key !== action.key) };

    case "UPDATE_KNOWN":
      return {
        ...state,
        knownItems: state.knownItems.map((r) => (r.key === action.key ? { ...r, ...action.patch } : r)),
      };

    case "SET_KNOWN_ITEMS":
      return { ...state, knownItems: action.items };

    case "SET_RESULT":
      return { ...state, result: action.result, lastInput: action.input, loading: false, error: "" };

    case "SET_LOADING":
      return { ...state, loading: action.loading };

    case "SET_ERROR":
      return { ...state, error: action.error, loading: false };

    case "SET_LOCKED_CAND":
      return { ...state, lockedCand: action.cand };

    case "SET_BID_INPUT":
      return { ...state, bidInput: action.value };

    case "SET_SAVING":
      return { ...state, saving: action.saving };

    case "SET_SAVED_MSG":
      return { ...state, savedMsg: action.msg };

    case "RESET":
      return { ...initialState, board: EMPTY_BOARD() };

    default:
      return state;
  }
}
