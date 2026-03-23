import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Update this to point to your ShiftLedger backend.
// In development use your local IP; in production always use an HTTPS URL
// (e.g. "https://shiftledger.example.com") to protect authentication tokens.
const BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';

const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

// Attach stored Bearer token to every request
apiClient.interceptors.request.use(
  async (config) => {
    const token = await AsyncStorage.getItem('auth_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

// Handle 401 responses: clear stored credentials so the auth store
// can redirect the user back to the login screen.
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      await AsyncStorage.removeItem('auth_token');
      await AsyncStorage.removeItem('auth_user');
    }
    return Promise.reject(error);
  },
);

// ── Auth API ──────────────────────────────────────────────────────────────────

export const authAPI = {
  login: (username, password) =>
    apiClient.post('/api/auth/login', { username, password }),

  signup: (username, password, display_name) =>
    apiClient.post('/api/auth/signup', { username, password, display_name }),

  logout: () => apiClient.post('/api/auth/logout'),

  refresh: () => apiClient.post('/api/auth/refresh'),

  status: () => apiClient.get('/api/auth/status'),
};

// ── Shifts API ────────────────────────────────────────────────────────────────

export const shiftsAPI = {
  getAll: (params) => apiClient.get('/api/shifts', { params }),

  create: (shift) => apiClient.post('/api/shifts', shift),

  update: (id, shift) => apiClient.put(`/api/shifts/${id}`, shift),

  remove: (id) => apiClient.delete(`/api/shifts/${id}`),
};

// ── Jobs API ──────────────────────────────────────────────────────────────────

export const jobsAPI = {
  getAll: () => apiClient.get('/api/jobs'),
};

export default apiClient;
