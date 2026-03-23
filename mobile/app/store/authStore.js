import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authAPI } from '../api/client';

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';

const useAuthStore = create((set, get) => ({
  user: null,
  token: null,
  isLoading: true,
  error: null,

  // Restore persisted session on app start
  hydrate: async () => {
    try {
      const [token, userJson] = await Promise.all([
        AsyncStorage.getItem(TOKEN_KEY),
        AsyncStorage.getItem(USER_KEY),
      ]);
      if (token && userJson) {
        set({ token, user: JSON.parse(userJson), isLoading: false });
      } else {
        set({ isLoading: false });
      }
    } catch {
      set({ isLoading: false });
    }
  },

  login: async (username, password) => {
    set({ error: null });
    try {
      const { data } = await authAPI.login(username, password);
      await AsyncStorage.setItem(TOKEN_KEY, data.token);
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(data.user));
      set({ token: data.token, user: data.user, error: null });
      return true;
    } catch (err) {
      const message = err.response?.data?.error || 'Login failed';
      set({ error: message });
      return false;
    }
  },

  signup: async (username, password, displayName) => {
    set({ error: null });
    try {
      const { data } = await authAPI.signup(username, password, displayName);
      await AsyncStorage.setItem(TOKEN_KEY, data.token);
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(data.user));
      set({ token: data.token, user: data.user, error: null });
      return true;
    } catch (err) {
      const message = err.response?.data?.error || 'Signup failed';
      set({ error: message });
      return false;
    }
  },

  logout: async () => {
    try {
      await authAPI.logout();
    } catch {
      // Ignore network errors on logout
    } finally {
      await AsyncStorage.removeItem(TOKEN_KEY);
      await AsyncStorage.removeItem(USER_KEY);
      set({ token: null, user: null, error: null });
    }
  },

  refresh: async () => {
    try {
      const { data } = await authAPI.refresh();
      await AsyncStorage.setItem(TOKEN_KEY, data.token);
      await AsyncStorage.setItem(USER_KEY, JSON.stringify(data.user));
      set({ token: data.token, user: data.user });
      return true;
    } catch {
      // Refresh failed — clear credentials so the app redirects to login
      await AsyncStorage.removeItem(TOKEN_KEY);
      await AsyncStorage.removeItem(USER_KEY);
      set({ token: null, user: null });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));

export default useAuthStore;
