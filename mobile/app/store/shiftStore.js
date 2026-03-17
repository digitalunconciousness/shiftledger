import create from 'zustand';

const useShiftStore = create((set) => ({
  shifts: [],
  loading: false,
  error: null,
  addShift: (shift) => set((state) => ({ shifts: [...state.shifts, shift] })),
  removeShift: (id) => set((state) => ({ shifts: state.shifts.filter(shift => shift.id !== id) })),
  updateShift: (id, updatedShift) => set((state) => ({ shifts: state.shifts.map(shift => shift.id === id ? { ...shift, ...updatedShift } : shift) })),
  clearShifts: () => set({ shifts: [] }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));

export default useShiftStore;