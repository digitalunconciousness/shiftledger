import axios from 'axios';

// Create an instance of axios
const apiClient = axios.create({
    baseURL: 'https://api.shiftledger.com', // Base URL for the API
    timeout: 10000, // Request timeout
});

// Interceptors for request 
apiClient.interceptors.request.use((config) => {
    const token = localStorage.getItem('authToken');
    if (token) {
        config.headers['Authorization'] = `Bearer ${token}`;
    }
    return config;
}, (error) => {
    return Promise.reject(error);
});

// Interceptors for response handling
apiClient.interceptors.response.use((response) => {
    return response;
}, (error) => {
    // Handle errors
    return Promise.reject(error);
});

// API endpoint definitions
const AuthService = {
    login: (credentials) => apiClient.post('/auth/login', credentials),
    logout: () => apiClient.post('/auth/logout')
};

const ShiftsService = {
    getShifts: () => apiClient.get('/shifts'),
    createShift: (shiftData) => apiClient.post('/shifts', shiftData)
};

const JobsService = {
    getJobs: () => apiClient.get('/jobs'),
    createJob: (jobData) => apiClient.post('/jobs', jobData)
};

const AnalyticsService = {
    getAnalytics: () => apiClient.get('/analytics')
};

export { AuthService, ShiftsService, JobsService, AnalyticsService };