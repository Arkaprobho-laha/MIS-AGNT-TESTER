(function () {
    'use strict';

    const app = angular.module('chatApp', []);

    // Helper to generate UUID v4
    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // Normalize timestamps from API: if the ISO string has no timezone indicator,
    // append 'Z' so JavaScript treats it as UTC and converts correctly to local time (IST).
    // Without this, API UTC timestamps are misread as local time — showing 5h30m behind.
    function normalizeTimestamp(ts) {
        if (!ts || typeof ts !== 'string') return ts;
        // Already has timezone info (Z, +HH:MM, -HH:MM)
        if (/[Z]$/i.test(ts) || /[+-]\d{2}:\d{2}$/.test(ts)) return ts;
        // Append Z to treat as UTC
        return ts + 'Z';
    }

    // Helper to mask JWT tokens for logs export
    function maskToken(token) {
        if (!token) return '';
        if (token.length <= 15) return '***';
        return token.substring(0, 8) + '...' + token.substring(token.length - 8);
    }

    // Helper to decode and check if a JWT token has expired
    function isTokenExpired(token) {
        try {
            const raw = token.replace(/^Bearer\s+/i, '');
            const payload = raw.split('.')[1];
            if (!payload) return false;
            const decoded = JSON.parse(atob(payload));
            if (decoded.exp) {
                return (Date.now() / 1000) > decoded.exp;
            }
        } catch (e) { }
        return false;
    }

    // Log Service: Manages complete API request/response logs in local storage
    app.service('LogService', ['$window', function ($window) {
        const self = this;
        const STORAGE_KEY = 'chat_api_network_logs';

        self.logs = [];

        // Load logs from storage
        // FIX: Normalize old log entries to ensure all required fields exist.
        //      Old logs may be missing method/url/status if saved by an older version.
        self.loadLogs = function () {
            try {
                const data = $window.localStorage.getItem(STORAGE_KEY);
                const raw = data ? JSON.parse(data) : [];
                // Normalise every entry — fill in any missing fields with safe defaults
                self.logs = raw.map(function (log) {
                    return {
                        id: log.id || generateUUID(),
                        timestamp: log.timestamp || new Date().toISOString(),
                        method: (log.method || 'GET').toUpperCase(),
                        url: log.url || '(unknown endpoint)',
                        reqHeaders: log.reqHeaders || null,
                        reqBody: log.reqBody || null,
                        resHeaders: log.resHeaders || null,
                        resBody: log.resBody || null,
                        status: log.status || 0,
                        latency: log.latency || 0
                    };
                });
            } catch (e) {
                console.error("Failed to load logs from localStorage", e);
                self.logs = [];
            }
            return self.logs;
        };

        // Save logs to storage (keeping max 150 entries to respect storage limits)
        // FIX: Use splice() in-place instead of reassigning self.logs to a new array.
        // Reassigning breaks the reference held by $scope.logs in the controller.
        self.saveLogs = function () {
            try {
                if (self.logs.length > 150) {
                    self.logs.splice(0, self.logs.length - 150);
                }
                $window.localStorage.setItem(STORAGE_KEY, JSON.stringify(self.logs));
            } catch (e) {
                console.error("Failed to save logs to localStorage", e);
            }
        };

        // Add a new API request/response entry
        self.addLog = function (method, url, reqHeaders, reqBody, resHeaders, resBody, status, latency) {
            // Create a deep copy of request headers and mask authorization token
            const headersCopy = angular.copy(reqHeaders || {});
            if (headersCopy['Authorization']) {
                headersCopy['Authorization'] = maskToken(headersCopy['Authorization']);
            }

            const newLog = {
                id: generateUUID(),
                timestamp: new Date().toISOString(),
                method: method,
                url: url,
                reqHeaders: headersCopy,
                reqBody: reqBody || null,
                resHeaders: resHeaders || null,
                resBody: resBody || null,
                status: status || 0,
                latency: latency || 0
            };

            self.logs.push(newLog);
            self.saveLogs();
        };

        // Clear logs
        // FIX: Use splice() in-place to preserve the array reference held by $scope.logs.
        self.clearLogs = function () {
            self.logs.splice(0, self.logs.length);
            $window.localStorage.removeItem(STORAGE_KEY);
        };

        // Serialize a value for export — handle null/undefined/object safely
        function serializeCell(val) {
            if (val === null || val === undefined) return '';
            if (typeof val === 'object') {
                try { return JSON.stringify(val); } catch (e) { return String(val); }
            }
            return String(val);
        }

        // Format logs data for exports
        self.getExportData = function () {
            return self.logs.map(l => ({
                'Timestamp': l.timestamp || '',
                'Method': l.method || '',
                'API Endpoint': l.url || '',
                'Status': l.status || '',
                'Duration (ms)': l.latency || '',
                'Request Headers': serializeCell(l.reqHeaders),
                'Request Body': serializeCell(l.reqBody),
                'Response Headers': serializeCell(l.resHeaders),
                'Response Body': serializeCell(l.resBody)
            }));
        };

        // Export data to CSV
        // FIX: Added UTF-8 BOM (\uFEFF) so Excel on Windows renders Unicode/Hindi text correctly.
        // FIX: Revoke the blob URL after click to prevent memory leak.
        // Export data to JSON
        self.exportJSON = function (data, filename) {
            if (!data || !data.length) {
                alert('No data available to export.');
                return;
            }
            try {
                const jsonContent = JSON.stringify(data, null, 2);

                // FIX: Use Blob instead of Data URI to bypass browser length limits
                const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8' });
                const url = URL.createObjectURL(blob);

                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();

                // FIX: 2000ms timeout ensures large files complete writing before cleanup
                setTimeout(function () {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 2000);
            } catch (e) {
                console.error('JSON export failed:', e);
                alert('JSON export failed: ' + e.message);
            }
        };

        // Export data to CSV
        self.exportCSV = function (data, filename) {
            if (!data || !data.length) {
                alert('No data available to export.');
                return;
            }
            try {
                const separator = ',';
                const keys = Object.keys(data[0]);

                const rows = data.map(row => keys.map(k => {
                    let cell = (row[k] === null || row[k] === undefined) ? '' : row[k];
                    cell = typeof cell === 'object' ? JSON.stringify(cell) : String(cell);
                    cell = cell.replace(/"/g, '""');  // escape double quotes
                    if (cell.search(/[,\n"]/g) >= 0) {
                        cell = '"' + cell + '"';  // wrap in quotes
                    }
                    return cell;
                }).join(separator));

                // \uFEFF = UTF-8 BOM — required for Excel to correctly decode Unicode characters
                const csvContent = '\uFEFF' + [keys.join(separator), ...rows].join('\n');

                const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
                const url = URL.createObjectURL(blob);

                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();

                // FIX: Increased from 300ms to 2000ms to prevent premature truncation
                setTimeout(function () {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 2000);
            } catch (e) {
                console.error('CSV export failed:', e);
                alert('CSV export failed: ' + e.message);
            }
        };

        // Export data to Excel using SheetJS (XLSX)
        // FIX: Sanitise data before writing — Excel has a 32,767 char limit per cell.
        //      Any cell exceeding this limit will crash SheetJS. We truncate long values.
        self.exportExcel = function (data, sheetName, filename) {
            if (!data || !data.length) {
                alert('No data available to export.');
                return;
            }
            try {
                if (typeof XLSX === 'undefined') {
                    // Fallback to CSV if XLSX library failed to load from CDN
                    console.warn('SheetJS (XLSX) library not loaded. Falling back to CSV.');
                    self.exportCSV(data, filename.replace(/\.xlsx$/i, '.csv'));
                    return;
                }

                const EXCEL_MAX_CELL = 32767;

                // Sanitise every cell: stringify objects and truncate to Excel's limit
                function sanitizeCell(val) {
                    if (val === null || val === undefined) return '';
                    let str = (typeof val === 'object') ? JSON.stringify(val) : String(val);
                    if (str.length > EXCEL_MAX_CELL) {
                        str = str.substring(0, EXCEL_MAX_CELL - 3) + '...';
                    }
                    return str;
                }

                // Build sanitised copy
                const safeData = data.map(row => {
                    const clean = {};
                    Object.keys(row).forEach(k => { clean[k] = sanitizeCell(row[k]); });
                    return clean;
                });

                const ws = XLSX.utils.json_to_sheet(safeData);
                // Auto-fit column widths based on content (capped at 80 chars)
                const colWidths = Object.keys(safeData[0]).map(key => ({
                    wch: Math.min(
                        Math.max(
                            key.length,
                            ...safeData.map(row => String(row[key] || '').length)
                        ),
                        80
                    )
                }));
                ws['!cols'] = colWidths;
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, sheetName.substring(0, 31));
                XLSX.writeFile(wb, filename);
            } catch (e) {
                console.error('Excel export failed:', e);
                alert('Excel export failed: ' + e.message);
            }
        };

        // Initialize logs
        self.loadLogs();
    }]);

    // Session Cache Service: Persists message_count and last_message per session in localStorage
    // This fixes the API returning message_count=0 by caching real data client-side
    app.service('SessionCacheService', ['$window', function ($window) {
        const self = this;
        const CACHE_KEY = 'chat_session_meta_v1';

        self.cache = {};

        // Load cache from localStorage
        self.load = function () {
            try {
                const raw = $window.localStorage.getItem(CACHE_KEY);
                self.cache = raw ? JSON.parse(raw) : {};
            } catch (e) {
                self.cache = {};
            }
            return self.cache;
        };

        // Persist cache to localStorage
        self.save = function () {
            try {
                $window.localStorage.setItem(CACHE_KEY, JSON.stringify(self.cache));
            } catch (e) { /* storage full - ignore */ }
        };

        // Strip markdown to plain-text preview
        function stripForPreview(text) {
            if (!text) return '';
            return text
                .replace(/```[\s\S]*?```/g, '[code]')
                .replace(/`([^`]+)`/g, '$1')
                .replace(/\*\*(.+?)\*\*/g, '$1')
                .replace(/\*(.+?)\*/g, '$1')
                .replace(/#{1,6}\s+(.+)/g, '$1')
                .replace(/\[(.+?)\]\(.+?\)/g, '$1')
                .replace(/\n+/g, ' ')
                .trim();
        }

        // Update cache for a session from its messages array
        self.update = function (sessionId, messages) {
            if (!sessionId || !messages || !messages.length) return;
            const lastMsg = messages[messages.length - 1];
            self.cache[sessionId] = {
                message_count: messages.length,
                last_message: stripForPreview(lastMsg.content || ''),
                last_role: lastMsg.role || 'agent',
                updated_at: new Date().toISOString()
            };
            self.save();
        };

        // Get cached metadata for a session
        self.get = function (sessionId) {
            return self.cache[sessionId] || null;
        };

        // Clear cache for a specific session
        self.clear = function (sessionId) {
            if (sessionId) {
                delete self.cache[sessionId];
            } else {
                self.cache = {};
            }
            self.save();
        };

        // Initialize on service creation
        self.load();
    }]);

    // API Service: Handles all API calls, authorization injection, and logging hookups
    app.service('ApiService', ['$http', 'LogService', function ($http, LogService) {
        const self = this;
        const BASE_URL = '/api/v1';

        self.token = '';

        self.setToken = function (token) {
            self.token = token || '';
        };

        // Standard request config helper
        function makeRequest(config) {
            const startTime = Date.now();

            // Set standard headers
            config.headers = config.headers || {};
            config.headers['accept'] = 'application/json';

            if (self.token) {
                config.headers['Authorization'] = self.token;
            }

            return $http(config).then(
                function (response) {
                    const latency = Date.now() - startTime;
                    LogService.addLog(
                        config.method,
                        config.url,
                        config.headers,
                        config.data,
                        response.headers(),
                        response.data,
                        response.status,
                        latency
                    );
                    return response.data;
                },
                function (error) {
                    const latency = Date.now() - startTime;
                    const errorData = error.data || { error: 'Unknown server error or network issue' };
                    LogService.addLog(
                        config.method,
                        config.url,
                        config.headers,
                        config.data,
                        error.headers ? error.headers() : null,
                        errorData,
                        error.status || -1,
                        latency
                    );
                    throw error;
                }
            );
        }

        // POST message
        // FIX: For new sessions, omit session_id so the API creates one and returns it.
        // For existing sessions, pass the session_id as before.
        self.sendMessage = function (message, sessionId) {
            const payload = { message: message };
            if (sessionId) {
                payload.session_id = sessionId;
            }
            return makeRequest({
                method: 'POST',
                url: BASE_URL + '/chat',
                data: payload
            });
        };

        // GET session list
        self.getSessions = function () {
            return makeRequest({
                method: 'GET',
                url: BASE_URL + '/chat/sessions'
            });
        };

        // GET session history
        self.getSessionHistory = function (sessionId) {
            return makeRequest({
                method: 'GET',
                url: BASE_URL + '/chat/' + sessionId + '/history'
            });
        };
    }]);

    // Main Chat Controller
    app.controller('ChatController', ['$scope', 'ApiService', 'LogService', 'SessionCacheService', '$timeout', '$window', function ($scope, ApiService, LogService, SessionCacheService, $timeout, $window) {
        $scope.auth = {
            token: $window.localStorage.getItem('chat_api_token') || ''
        };
        $scope.sessions = [];
        $scope.activeSessionId = '';
        // Flag: is the current session a brand-new one (not yet confirmed by API)?
        $scope.isNewSession = false;
        $scope.messages = [];
        $scope.newMessage = '';

        $scope.isConsoleOpen = false;
        $scope.isSidebarOpen = false;  // For mobile sidebar drawer
        $scope.logs = LogService.logs;
        $scope.loading = false;
        $scope.authError = '';
        $scope.isAuthorized = false;

        // Custom UI states
        $scope.isTokenSaved = false;

        // Log display slider state
        $scope.logDisplayCount = Math.min(20, LogService.logs.length || 20);
        $scope.sliderBg = {};

        // Update slider background fill to reflect current value
        $scope.updateSliderStyle = function () {
            const count = parseInt($scope.logDisplayCount, 10) || 1;
            const max = Math.max($scope.logs.length, 1);
            const pct = Math.round((count / max) * 100);
            $scope.sliderBg = {
                background: 'linear-gradient(to right, #06b6d4 0%, #06b6d4 ' + pct + '%, rgba(255,255,255,0.08) ' + pct + '%, rgba(255,255,255,0.08) 100%)'
            };
        };

        // Watch logs length so slider max and display count stay in sync
        $scope.$watchCollection('logs', function (newLogs) {
            if (!newLogs) return;
            const total = newLogs.length;
            // If count was at the previous max (show-all), keep it at new max
            if ($scope.logDisplayCount >= total - 1 || $scope.logDisplayCount === 0) {
                $scope.logDisplayCount = total || 1;
            }
            $scope.updateSliderStyle();
        });

        // Initial slider fill on load
        $scope.updateSliderStyle();

        // Initialize API Service with token if available
        // FIX: Auto-prefix 'Bearer ' if not already present
        function normalizeToken(raw) {
            if (!raw) return '';
            const trimmed = raw.trim();
            // If it looks like a JWT (starts with eyJ) and doesn't have Bearer prefix, add it
            if (trimmed.startsWith('eyJ') && !trimmed.startsWith('Bearer ')) {
                return 'Bearer ' + trimmed;
            }
            return trimmed;
        }

        if ($scope.auth.token) {
            if (isTokenExpired($scope.auth.token)) {
                // Token found in storage but expired — clear it, show auth form
                $scope.auth.token = '';
                $window.localStorage.removeItem('chat_api_token');
                $scope.authError = 'Your saved token has expired. Please paste a new one.';
            } else {
                ApiService.setToken(normalizeToken($scope.auth.token));
                $scope.isAuthorized = true;
            }
        }

        // Save token & Authorize
        $scope.saveToken = function () {
            if (!$scope.auth.token) {
                $scope.authError = 'Token cannot be empty';
                $scope.isAuthorized = false;
                return;
            }
            // FIX: Reject expired tokens immediately before saving
            if (isTokenExpired($scope.auth.token)) {
                $scope.authError = 'This token has already expired. Please use a valid token.';
                $scope.isAuthorized = false;
                return;
            }
            $scope.authError = '';
            $window.localStorage.setItem('chat_api_token', $scope.auth.token);
            ApiService.setToken(normalizeToken($scope.auth.token));
            $scope.isAuthorized = true;
            $scope.isTokenSaved = true;

            // FIX: Clear old chat state when switching tokens to prevent stale UI
            $scope.messages = [];
            $scope.activeSessionId = '';
            $scope.isNewSession = false;

            // Auto hide token saved feedback after 2s
            $timeout(function () {
                $scope.isTokenSaved = false;
            }, 2500);

            // Fetch sessions lists immediately
            $scope.loadSessions();
        };

        // Reset/Logout token
        $scope.resetToken = function () {
            $scope.auth.token = '';
            $window.localStorage.removeItem('chat_api_token');
            ApiService.setToken('');
            $scope.isAuthorized = false;
            // FIX: Clear authError so it doesn't persist after disconnect
            $scope.authError = '';
            $scope.sessions = [];
            $scope.activeSessionId = '';
            $scope.isNewSession = false;
            $scope.messages = [];
        };

        // Load Session lists
        $scope.loadSessions = function () {
            if (!$scope.isAuthorized) return;
            $scope.loading = true;
            ApiService.getSessions().then(
                function (response) {
                    if (response.success && response.data) {
                        // FIX: Normalize API timestamps to UTC so AngularJS converts them to local IST
                        // CACHE FIX: Merge cached message_count and last_message (API always returns 0)
                        $scope.sessions = response.data.map(function (s) {
                            s.created_at = normalizeTimestamp(s.created_at);
                            const cached = SessionCacheService.get(s.id);
                            if (cached) {
                                s.message_count = cached.message_count;
                                s.last_message = cached.last_message;
                                s.last_role = cached.last_role;
                            }
                            return s;
                        });

                        // Background Auto-fetch: fetch missing histories to populate real-time metadata
                        $scope.sessions.forEach(function (sess) {
                            sess._loading = true;
                            ApiService.getSessionHistory(sess.id).then(function (histRes) {
                                sess._loading = false;
                                if (histRes.success && histRes.data) {
                                    const msgs = histRes.data.map(msg => ({
                                        id: msg.id,
                                        role: msg.role === 'user' ? 'user' : 'agent',
                                        content: msg.content,
                                        created_at: normalizeTimestamp(msg.created_at)
                                    }));
                                    syncSessionMeta(sess.id, msgs);
                                }
                            }, function () {
                                sess._loading = false;
                            });
                        });
                    }
                    $scope.loading = false;
                },
                function (err) {
                    $scope.loading = false;
                    if (err.status === 401) {
                        $scope.authError = 'Unauthorized token. Please update your token credentials.';
                        $scope.isAuthorized = false;
                    } else {
                        console.error('Failed to load sessions', err);
                    }
                }
            );
        };

        // Helper: Update session cache and sync it into the sidebar session entry
        function syncSessionMeta(sessionId, messages) {
            if (!sessionId || !messages) return;
            SessionCacheService.update(sessionId, messages);
            const sess = $scope.sessions.find(function (s) { return s.id === sessionId; });
            if (sess) {
                const cached = SessionCacheService.get(sessionId);
                if (cached) {
                    sess.message_count = cached.message_count;
                    sess.last_message = cached.last_message;
                    sess.last_role = cached.last_role;
                }
            }
        }

        // Start a brand new Chat
        // FIX: Do NOT generate a client-side UUID. Mark it as new session.
        // The actual session_id will be assigned by the API on first message.
        $scope.startNewChat = function () {
            $scope.activeSessionId = '';   // No ID yet — API will provide one
            $scope.isNewSession = true;    // Flag so sendMessage knows to omit session_id
            $scope.messages = [];
            $scope.isSidebarOpen = false;  // Close mobile sidebar
            $scope.scrollToBottom();
        };

        // Select an existing session and load its history
        $scope.selectSession = function (sessionId) {
            if ($scope.activeSessionId === sessionId && !$scope.isNewSession) return;
            $scope.activeSessionId = sessionId;
            $scope.isNewSession = false;
            $scope.messages = [];
            $scope.loading = true;
            $scope.isSidebarOpen = false;  // Close mobile sidebar

            ApiService.getSessionHistory(sessionId).then(
                function (response) {
                    if (response.success && response.data) {
                        $scope.messages = response.data.map(msg => ({
                            id: msg.id,
                            role: msg.role === 'user' ? 'user' : 'agent',
                            content: msg.content,
                            // FIX: Normalize API timestamps to UTC for correct IST display
                            created_at: normalizeTimestamp(msg.created_at),
                            sources: msg.sources || [],
                            tool_calls: msg.tool_calls || []
                        }));
                        // CACHE: Persist real message count + last message for this session
                        syncSessionMeta(sessionId, $scope.messages);
                    }
                    $scope.loading = false;
                    $scope.scrollToBottom();
                },
                function (err) {
                    $scope.loading = false;
                    console.error('Failed to load chat history for session ' + sessionId, err);
                }
            );
        };

        // Delete session locally
        $scope.deleteSessionLocally = function (sessionId, event) {
            if (event) {
                event.stopPropagation();
                event.preventDefault();
            }
            $scope.sessions = $scope.sessions.filter(s => s.id !== sessionId);
            if ($scope.activeSessionId === sessionId) {
                $scope.activeSessionId = '';
                $scope.isNewSession = false;
                $scope.messages = [];
            }
        };

        // Export a specific session as CSV directly from the sidebar
        $scope.exportSessionCSV = function (sessionId, event) {
            if (event) {
                event.stopPropagation();
                event.preventDefault();
            }
            // Fetch latest history to export
            ApiService.getSessionHistory(sessionId).then(
                function (response) {
                    if (response.success && response.data) {
                        const msgs = response.data.map(msg => ({
                            id: msg.id,
                            role: msg.role === 'user' ? 'user' : 'agent',
                            content: msg.content,
                            created_at: normalizeTimestamp(msg.created_at),
                            sources: msg.sources || [],
                            tool_calls: msg.tool_calls || []
                        }));
                        if (!msgs || !msgs.length) {
                            alert("No chat messages in this session to export.");
                            return;
                        }
                        const chatData = msgs.map(m => ({
                            'Session ID': sessionId,
                            'Timestamp': m.created_at,
                            'Role': m.role,
                            'Message Content': m.content,
                            'Sources': JSON.stringify(m.sources || []),
                            'Tool Calls': JSON.stringify(m.tool_calls || [])
                        }));
                        const sessionPrefix = sessionId.substring(0, 8);
                        const filename = `chat_history_${sessionPrefix}_${Date.now()}.csv`;
                        LogService.exportCSV(chatData, filename);
                    }
                },
                function (err) {
                    console.error('Failed to load chat history for export', err);
                    alert('Failed to load chat history for export.');
                }
            );
        };

        // Reload active session's history from the API (manual refresh)
        $scope.reloadSession = function () {
            if (!$scope.activeSessionId || $scope.isNewSession) return;
            $scope.messages = [];
            $scope.loading = true;
            ApiService.getSessionHistory($scope.activeSessionId).then(
                function (response) {
                    if (response.success && response.data) {
                        $scope.messages = response.data.map(msg => ({
                            id: msg.id,
                            role: msg.role === 'user' ? 'user' : 'agent',
                            content: msg.content,
                            created_at: normalizeTimestamp(msg.created_at),
                            sources: msg.sources || [],
                            tool_calls: msg.tool_calls || []
                        }));
                        // CACHE: Persist real message count + last message after manual reload
                        syncSessionMeta($scope.activeSessionId, $scope.messages);
                    }
                    $scope.loading = false;
                    $scope.scrollToBottom();
                },
                function (err) {
                    $scope.loading = false;
                    console.error('Failed to reload session history', err);
                    if (err.status === 401) {
                        $scope.isAuthorized = false;
                        $scope.authError = 'Token expired. Please disconnect and reconnect.';
                    }
                }
            );
        };

        // Send a message
        // FIX: For new sessions, send WITHOUT session_id. Use the session_id from API response.
        //      For existing sessions, send WITH session_id as before.
        $scope.sendMessage = function () {
            if (!$scope.newMessage.trim() || $scope.loading) return;
            if (!$scope.isAuthorized) {
                alert("Please authorize with an API token first.");
                return;
            }

            const promptText = $scope.newMessage;
            $scope.newMessage = '';

            // Determine session_id to send:
            // - If isNewSession flag is set or no activeSessionId, send null (API creates new session)
            // - If activeSessionId exists (existing session), send it
            const sessionIdToSend = ($scope.isNewSession || !$scope.activeSessionId)
                ? null
                : $scope.activeSessionId;

            // Render message user side immediately
            const userMsg = {
                id: generateUUID(),
                role: 'user',
                content: promptText,
                created_at: new Date().toISOString()
            };
            $scope.messages.push(userMsg);
            $scope.scrollToBottom();

            $scope.loading = true;

            ApiService.sendMessage(promptText, sessionIdToSend).then(
                function (response) {
                    $scope.loading = false;
                    if (response.success && response.data) {
                        const agentMsg = {
                            id: generateUUID(),
                            role: 'agent',
                            content: response.data.reply || '',
                            created_at: new Date().toISOString(),
                            sources: response.data.sources || [],
                            tool_calls: response.data.tool_calls || []
                        };
                        $scope.messages.push(agentMsg);

                        // FIX: If this was a new session, get the session_id from the API response
                        if ($scope.isNewSession) {
                            const newSessionId = response.data.session_id || response.session_id;
                            if (newSessionId) {
                                $scope.activeSessionId = newSessionId;
                                $scope.isNewSession = false;
                                // Add to sessions list at the top
                                $scope.sessions.unshift({
                                    id: newSessionId,
                                    created_at: new Date().toISOString(),
                                    message_count: $scope.messages.length
                                });
                                // CACHE: Persist new session metadata immediately
                                syncSessionMeta(newSessionId, $scope.messages);
                            }
                        } else {
                            // CACHE: Update existing session metadata in real-time
                            syncSessionMeta($scope.activeSessionId, $scope.messages);
                        }
                    }
                    $scope.scrollToBottom();
                },
                function (err) {
                    $scope.loading = false;
                    let errorMsg = 'Error: Failed to fetch reply from AI Agent API. Please check your token or server status.';
                    if (err.data && err.data.detail) {
                        errorMsg = `Error: ${err.data.detail}`;
                    } else if (err.data && err.data.message) {
                        errorMsg = `Error: ${err.data.message}`;
                    } else if (err.data && typeof err.data === 'string') {
                        errorMsg = `Error: ${err.data}`;
                    } else if (err.status === 401) {
                        errorMsg = 'Error (401): Token expired or unauthorized. Please reconnect with a valid token.';
                        // FIX: Revoke auth state so UI returns to login form
                        $scope.isAuthorized = false;
                        ApiService.setToken('');
                        $scope.authError = 'Token expired. Please disconnect and reconnect with a valid token.';
                    } else if (err.status === 422) {
                        errorMsg = 'Error (422): Request validation failed. Please check your input.';
                    } else if (err.status === 500) {
                        errorMsg = 'Error (500): Server error. Please try again or select an existing session.';
                    }

                    // Append error message to chat
                    $scope.messages.push({
                        id: generateUUID(),
                        role: 'agent',
                        content: errorMsg,
                        created_at: new Date().toISOString(),
                        isError: true
                    });
                    $scope.scrollToBottom();
                }
            );
        };

        // Export Active Chat history
        $scope.exportChat = function (format) {
            if (!$scope.messages || !$scope.messages.length) {
                alert("No chat messages in the active session to export.");
                return;
            }

            const chatData = $scope.messages.map(m => ({
                'Session ID': $scope.activeSessionId,
                'Timestamp': m.created_at,
                'Role': m.role,
                'Message Content': m.content,
                'Sources': JSON.stringify(m.sources || []),
                'Tool Calls': JSON.stringify(m.tool_calls || [])
            }));

            const sessionPrefix = $scope.activeSessionId ? $scope.activeSessionId.substring(0, 8) : 'new';
            const filename = `chat_history_${sessionPrefix}_${Date.now()}`;

            if (format === 'excel') {
                LogService.exportExcel(chatData, 'Chat History', `${filename}.xlsx`);
            } else {
                LogService.exportCSV(chatData, `${filename}.csv`);
            }
        };

        // Export complete API Network logs
        $scope.exportNetworkLogs = function (format) {
            const logData = LogService.getExportData();
            const filename = `api_network_logs_${Date.now()}`;

            if (format === 'excel') {
                LogService.exportExcel(logData, 'API Logs', `${filename}.xlsx`);
            } else if (format === 'json') {
                LogService.exportJSON(logData, `${filename}.json`);
            } else {
                LogService.exportCSV(logData, `${filename}.csv`);
            }
        };

        // Clear local logs
        $scope.clearLogs = function () {
            // LogService.clearLogs() now splices in-place, so $scope.logs reference stays valid
            LogService.clearLogs();
        };

        // Toggle Console Drawer
        $scope.toggleConsole = function () {
            $scope.isConsoleOpen = !$scope.isConsoleOpen;
            // No need to reassign $scope.logs — it shares the same array reference as LogService.logs
        };

        // Toggle mobile sidebar
        $scope.toggleSidebar = function () {
            $scope.isSidebarOpen = !$scope.isSidebarOpen;
        };

        // Copy Message to Clipboard
        $scope.copyMessage = function (text, event) {
            if (event) {
                event.stopPropagation();
            }
            if (!text) return;

            // Visual feedback function (changes icon to a green checkmark)
            function showFeedback(btn) {
                if (!btn) return;
                const icon = btn.querySelector('i');
                if (icon) {
                    const originalClass = icon.className;
                    icon.className = 'fa-solid fa-check';
                    icon.style.color = 'var(--accent-green)';
                    $timeout(function () {
                        icon.className = originalClass;
                        icon.style.color = '';
                    }, 2000); // Reverts after 2 seconds
                }
            }

            const targetBtn = event.currentTarget;

            // Use modern clipboard API if available
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(function () {
                    showFeedback(targetBtn);
                }).catch(function (err) {
                    console.error('Clipboard copy failed', err);
                });
            } else {
                // Fallback for older browsers
                const textArea = document.createElement("textarea");
                textArea.value = text;
                textArea.style.position = "fixed";
                textArea.style.left = "-999999px";
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                try {
                    document.execCommand('copy');
                    showFeedback(targetBtn);
                } catch (err) {
                    console.error('Fallback copy failed', err);
                }
                document.body.removeChild(textArea);
            }
        };

        // Format JSON payload helper
        $scope.formatJSON = function (data) {
            if (!data) return 'None';
            if (typeof data === 'string') {
                try {
                    return JSON.stringify(JSON.parse(data), null, 2);
                } catch (e) {
                    return data;
                }
            }
            return JSON.stringify(data, null, 2);
        };

        // Auto-Scroll to bottom helper
        $scope.scrollToBottom = function () {
            $timeout(function () {
                const element = document.getElementById('chat-messages-container');
                if (element) {
                    element.scrollTop = element.scrollHeight;
                }
            }, 100);
        };

        // Auto-grow textarea on input
        // FIX: Use element ID instead of event.target so it works with ng-keyup and ng-paste
        $scope.autoGrowTextarea = function () {
            const el = document.getElementById('chat-textarea');
            if (!el) return;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 200) + 'px';
        };

        // Load sessions lists on boot if authorized
        if ($scope.isAuthorized) {
            $scope.loadSessions();
        }
    }]);

    // Improved markdown filter for AngularJS
    app.filter('markdown', ['$sce', function ($sce) {
        return function (text) {
            if (!text) return '';

            // 1. Escape HTML first (prevents XSS from raw text)
            let html = text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');

            // 2. Fenced code blocks: ```lang\ncode\n``` — extract first to protect from other rules
            const codeBlocks = [];
            html = html.replace(/```([\w-]*)\n([\s\S]*?)\n```/g, function (match, lang, code) {
                const placeholder = '\x00CODE' + codeBlocks.length + '\x00';
                codeBlocks.push('<pre><code class="language-' + (lang || 'text') + '">' + code + '</code></pre>');
                return placeholder;
            });

            // 3. Inline code: `code` — protect from other rules
            const inlineCodes = [];
            html = html.replace(/`([^`\n]+)`/g, function (match, code) {
                const placeholder = '\x00INLINE' + inlineCodes.length + '\x00';
                inlineCodes.push('<code>' + code + '</code>');
                return placeholder;
            });

            // 4. Headings (must be processed before other line-level rules)
            html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
            html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
            html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

            // 5. Bold: **text**
            html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

            // 6. Italic: *text* or _text_ (only where not bold)
            html = html.replace(/(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
            html = html.replace(/\b_([^_\n]+)_\b/g, '<em>$1</em>');

            // 7. Markdown links: [text](url)
            html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

            // 8. Ordered lists: lines starting with digit + ". "
            //    Process contiguous blocks of ordered-list lines into <ol>
            html = html.replace(/((?:^|\n)\d+\.\s+.+)+/g, function (block) {
                const items = block.trim().split('\n').map(line => {
                    return '<li>' + line.replace(/^\d+\.\s+/, '') + '</li>';
                }).join('');
                return '<ol>' + items + '</ol>';
            });

            // 9. Unordered lists: lines starting with - or *
            //    Process contiguous blocks of bullet-list lines into <ul>
            html = html.replace(/((?:^|\n)[ \t]*[-*]\s+.+)+/g, function (block) {
                const items = block.trim().split('\n').map(line => {
                    return '<li>' + line.replace(/^[ \t]*[-*]\s+/, '') + '</li>';
                }).join('');
                return '<ul>' + items + '</ul>';
            });

            // 10. Horizontal rule: --- or ***
            html = html.replace(/^[-*]{3,}$/gm, '<hr/>');

            // 11. Restore code blocks and inline codes before adding line breaks
            codeBlocks.forEach(function (block, i) {
                html = html.replace('\x00CODE' + i + '\x00', block);
            });
            inlineCodes.forEach(function (code, i) {
                html = html.replace('\x00INLINE' + i + '\x00', code);
            });

            // 12. Convert newlines to <br/> — but NOT inside block-level HTML elements
            //     We do a simple approach: split on block tags, add <br/> to text segments only
            html = html.replace(/\n(?!<\/?(ul|ol|li|pre|h[1-6]|hr))/g, '<br/>');

            return $sce.trustAsHtml(html);
        };
    }]);

})();
