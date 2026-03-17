import { create } from 'zustand';
import { shiftsAPI, jobsAPI } from '../api/client';

const useShiftStore = create((set, get) => ({
  shifts: [],
  jobs: [],
  isLoading: false,
  error: null,

  // ── Shifts ────────────────────────────────────────────────────────────────

  fetchShifts: async (params) => {
    set({ isLoading: true, error: null });
    try {
      const { data } = await shiftsAPI.getAll(params);
      set({ shifts: data, isLoading: false });
    } catch (err) {
      set({ error: err.response?.data?.error || 'Failed to load shifts', isLoading: false });
    }
  },

  addShift: async (shiftData) => {
    set({ error: null });
    try {
      const { data } = await shiftsAPI.create(shiftData);
      // Refresh the list after creating
      await get().fetchShifts();
      return { success: true, data };
    } catch (err) {
      const message = err.response?.data?.error || 'Failed to create shift';
      set({ error: message });
      return { success: false, error: message };
    }
  },

  updateShift: async (id, shiftData) => {
    set({ error: null });
    try {
      const { data } = await shiftsAPI.update(id, shiftData);
      // Update the shift in local state
      set((state) => ({
        shifts: state.shifts.map((s) =>
          s.id === id ? { ...s, ...shiftData, ...data } : s,
        ),
      }));
      return { success: true };
    } catch (err) {
      const message = err.response?.data?.error || 'Failed to update shift';
      set({ error: message });
      return { success: false, error: message };
    }
  },

  deleteShift: async (id) => {
    set({ error: null });
    try {
      await shiftsAPI.remove(id);
      set((state) => ({ shifts: state.shifts.filter((s) => s.id !== id) }));
      return { success: true };
    } catch (err) {
      const message = err.response?.data?.error || 'Failed to delete shift';
      set({ error: message });
      return { success: false, error: message };
    }
  },

  // ── Jobs ──────────────────────────────────────────────────────────────────

  fetchJobs: async () => {
    try {
      const { data } = await jobsAPI.getAll();
      set({ jobs: data });
    } catch {
      // Non-critical; silently ignore job fetch errors
    }
  },

  // ── Filters ───────────────────────────────────────────────────────────────

  filterShifts: (query, jobId) => {
    const { shifts } = get();
    return shifts.filter((shift) => {
      const matchesQuery =
        !query ||
        shift.date.includes(query) ||
        (shift.job_name && shift.job_name.toLowerCase().includes(query.toLowerCase())) ||
        (shift.notes && shift.notes.toLowerCase().includes(query.toLowerCase()));
      const matchesJob = !jobId || shift.job_id === jobId;
      return matchesQuery && matchesJob;
    });
  },

  clearError: () => set({ error: null }),
}));

export default useShiftStore;
