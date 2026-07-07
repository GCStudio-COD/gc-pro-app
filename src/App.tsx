// @ts-nocheck
import { useState, useEffect, useRef } from "react";
import { Play, Pause, Search, Plus, MoreVertical, RefreshCw, ChevronLeft, ChevronRight, Check } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { listen } from "@tauri-apps/api/event";
import { GoogleOAuthProvider } from '@react-oauth/google';
import "./App.css";

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function App() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  // Auto-Updater Check
  useEffect(() => {
    async function checkForUpdates() {
      if (!isTauri()) return;
      try {
        const update = await check();
        if (update) {
          console.log(`Update available: ${update.version}`);
          await update.downloadAndInstall();
          // Ask Tauri to restart the app (requires importing relaunch from @tauri-apps/plugin-process or simply alert user)
          alert("A new update has been installed! Please restart the app.");
        }
      } catch (err) {
        console.error("Failed to check for updates:", err);
      }
    }
    checkForUpdates();
  }, []);

  const handleDeepLinkToken = async (token: string) => {
    setIsAuthLoading(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const employee = await res.json();
        localStorage.setItem("authToken", token);
        localStorage.setItem("loginTimestamp", new Date().toISOString());
        
        setToken(token);
        setUser(employee);
        
        let role = "Employee";
        if (employee.role === 'admin' || employee.role === 'SuperAdmin') role = "Admin";
        else if (employee.role === 'project-manager') role = "PM";
        
        setUserRole(role as "Admin" | "PM" | "Employee");
        setIsAuthenticated(true);
        fetchProjects(token, employee.id);
        fetchAttendanceStatus(token);
      } else {
        alert("Authentication failed. Please try again.");
      }
    } catch (e) {
      alert("Network error authenticating via deep link");
    } finally {
      setIsAuthLoading(false);
    }
  };

  // Deep-Link Listener
  useEffect(() => {
    if (!isTauri()) return;

    // 1. Standard Tauri v2 deep-link plugin listener
    const unlisten = onOpenUrl(async (urls) => {
      console.log('Deep link opened (onOpenUrl):', urls);
      for (const url of urls) {
        if (url.includes('token=')) {
          const token = url.split('token=')[1];
          if (token) {
             handleDeepLinkToken(token);
          }
        }
      }
    });

    // 2. Fallback listener directly from single-instance event (for Windows)
    const unlistenEvent = listen<string[]>('deep-link-received', (event) => {
      console.log('Deep link opened (single-instance event):', event.payload);
      for (const arg of event.payload) {
        if (arg.includes('token=')) {
          const token = arg.split('token=')[1];
          if (token) {
             handleDeepLinkToken(token);
          }
        }
      }
    });

    return () => {
      unlisten.then(fn => fn());
      unlistenEvent.then(fn => fn());
    };
  }, []);
  const [userRole, setUserRole] = useState<"Admin" | "PM" | "Employee">("Admin");
  
  // State for Authentication
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [authMode, setAuthMode] = useState<"login" | "signup" | "otp" | "forgot-password" | "reset-password">("login");
  const [signupEmail, setSignupEmail] = useState<string>("");
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(false);
  const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);
  const [isAvatarMenuOpen, setIsAvatarMenuOpen] = useState<boolean>(false);
  const [taskFilter, setTaskFilter] = useState<"all" | "completed" | "pending">("all");

  useEffect(() => {
    const handleOutsideClick = () => {
      setIsMenuOpen(false);
      setIsAvatarMenuOpen(false);
    };
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  // State for Check-in flow
  const [isCheckedIn, setIsCheckedIn] = useState<boolean>(false);
  const [currentRealTime, setCurrentRealTime] = useState<Date>(new Date());
  const isTransitioningRef = useRef(false);
  
  // Shift tracking
  const [checkInTime, setCheckInTime] = useState<Date | null>(null);
  const [accumulatedShiftSeconds, setAccumulatedShiftSeconds] = useState<number>(0);
  const [lastActiveDateString, setLastActiveDateString] = useState<string>(new Date().toDateString());

  // Last updated state (when a project completes)
  const [lastProjectCompletedAt, setLastProjectCompletedAt] = useState<Date | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      setCurrentRealTime(now);
      
      setLastActiveDateString(prev => {
        const currentString = now.toDateString();
        if (prev !== currentString) {
          setAccumulatedShiftSeconds(0);
          return currentString;
        }
        return prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatRealTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const formatTimeOnly = (date: Date) => {
    return date.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }).split(' ')[0];
  };

  const formatAmPm = (date: Date) => {
    const parts = date.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }).split(' ');
    return parts.length > 1 ? parts[1] : '';
  };

  const currentShiftSeconds = checkInTime ? Math.floor((currentRealTime.getTime() - checkInTime.getTime()) / 1000) : 0;
  const totalWorkedSeconds = accumulatedShiftSeconds + currentShiftSeconds;

  const [activeAttendanceLogId, setActiveAttendanceLogId] = useState<string | null>(null);

  // Sync Queue State
  const [syncQueue, setSyncQueue] = useState<any[]>(() => {
    try {
      const q = localStorage.getItem('syncQueue');
      return q ? JSON.parse(q) : [];
    } catch {
      return [];
    }
  });

  const addToSyncQueue = (action: any) => {
    setSyncQueue(prev => {
      const newQueue = [...prev, { ...action, timestamp: new Date().toISOString() }];
      localStorage.setItem('syncQueue', JSON.stringify(newQueue));
      return newQueue;
    });
  };

  const handleCheckIn = async () => {
    isTransitioningRef.current = true;
    setCheckInTime(new Date());
    setIsCheckedIn(true);
    
    if (!navigator.onLine) {
      addToSyncQueue({ type: 'check-in' });
      isTransitioningRef.current = false;
      return;
    }

    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/attendance/check-in`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}` 
        },
        body: JSON.stringify({ employeeId: user?.id })
      });
      const data = await response.json();
      setActiveAttendanceLogId(data.attendanceLogId);
    } catch (error) {
      console.error('Failed to check in, queueing offline', error);
      addToSyncQueue({ type: 'check-in' });
    } finally {
      isTransitioningRef.current = false;
    }
  };

  const handleCheckOut = async () => {
    isTransitioningRef.current = true;
    // Optimistic UI updates
    if (checkInTime) {
      setAccumulatedShiftSeconds(prev => prev + Math.floor((new Date().getTime() - checkInTime.getTime()) / 1000));
    }
    setCheckInTime(null);
    setIsCheckedIn(false);
    
    // Call backend to checkout
    if (!navigator.onLine) {
      addToSyncQueue({ type: 'check-out' });
      stopBackendTimer();
      isTransitioningRef.current = false;
      return;
    }

    if (activeAttendanceLogId) {
      try {
        await fetch(`${import.meta.env.VITE_API_BASE_URL}/attendance/check-out`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}` 
          },
          body: JSON.stringify({ attendanceLogId: activeAttendanceLogId })
        });
        setActiveAttendanceLogId(null);
        // Resync perfectly with server
        if (token) fetchAttendanceStatus(token);
      } catch (error) {
        console.error('Failed to check out, queueing offline', error);
        addToSyncQueue({ type: 'check-out' });
      } finally {
        isTransitioningRef.current = false;
      }
    } else {
      // If we don't have an ID but we tried to check out online, it means check-in was offline
      addToSyncQueue({ type: 'check-out' });
      isTransitioningRef.current = false;
    }

    // Also pause the active task timer if running
    stopBackendTimer();
  };


  // State for which project's tasks to show in the main To-do list (null means 'All')
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  // State for the currently active/selected task
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Timer state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [taskTimes, setTaskTimes] = useState<Record<string, number>>({});
  const [activeTimeLogId, setActiveTimeLogId] = useState<string | null>(null);

  const startBackendTimer = async (taskId: string) => {
    setIsPlaying(true);
    
    if (!navigator.onLine) {
      addToSyncQueue({ type: 'start-timer', taskId });
      return;
    }

    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/time-logs/start`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}` 
        },
        body: JSON.stringify({
          employeeId: user?.id,
          taskId: taskId
        })
      });
      const data = await response.json();
      setActiveTimeLogId(data.timeLogId);
      
      // Update task status to "In Progress"
      if (token) {
        fetch(`http://localhost:3002/api/tasks/${taskId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ status: 'In Progress' })
        }).catch(console.error);
      }
    } catch (error) {
      console.error('Failed to start timer, queueing offline', error);
      addToSyncQueue({ type: 'start-timer', taskId });
    }
  };

  const stopBackendTimer = async () => {
    setIsPlaying(false);
    
    if (!navigator.onLine) {
      addToSyncQueue({ type: 'stop-timer' });
      return;
    }

    if (!activeTimeLogId) {
      addToSyncQueue({ type: 'stop-timer' });
      return;
    }
    
    try {
      await fetch(`${import.meta.env.VITE_API_BASE_URL}/time-logs/stop`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}` 
        },
        body: JSON.stringify({ timeLogId: activeTimeLogId })
      });
      setActiveTimeLogId(null);
    } catch (error) {
      console.error('Failed to stop timer, queueing offline', error);
      addToSyncQueue({ type: 'stop-timer' });
    }
  };

  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    const interval = setInterval(async () => {
      if (!navigator.onLine || syncQueue.length === 0 || isSyncing || !token) return;
      
      setIsSyncing(true);
      
      let currentQueue = [...syncQueue];
      let currentAttendanceLogId = activeAttendanceLogId;
      let currentTimeLogId = activeTimeLogId;
      
      try {
        for (let i = 0; i < currentQueue.length; i++) {
          const action = currentQueue[i];
          
          if (action.type === 'check-in') {
            const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/attendance/check-in`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ employeeId: user?.id, timestamp: action.timestamp })
            });
            const data = await res.json();
            currentAttendanceLogId = data.attendanceLogId;
          } else if (action.type === 'check-out') {
            await fetch(`${import.meta.env.VITE_API_BASE_URL}/attendance/check-out`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ attendanceLogId: currentAttendanceLogId, timestamp: action.timestamp })
            });
            currentAttendanceLogId = null;
          } else if (action.type === 'start-timer') {
            const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/time-logs/start`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ employeeId: user?.id, taskId: action.taskId, timestamp: action.timestamp })
            });
            const data = await res.json();
            currentTimeLogId = data.timeLogId;
          } else if (action.type === 'stop-timer') {
            await fetch(`${import.meta.env.VITE_API_BASE_URL}/time-logs/stop`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({ timeLogId: currentTimeLogId, timestamp: action.timestamp })
            });
            currentTimeLogId = null;
          }
        }
        
        // Sync complete, clear queue
        setSyncQueue([]);
        localStorage.removeItem('syncQueue');
        setActiveAttendanceLogId(currentAttendanceLogId);
        setActiveTimeLogId(currentTimeLogId);
        
      } catch (err) {
        console.error("Sync failed partway through", err);
      } finally {
        setIsSyncing(false);
      }
    }, 5000);
    
    return () => clearInterval(interval);
  }, [navigator.onLine, syncQueue, isSyncing, token, activeAttendanceLogId, activeTimeLogId, user]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isPlaying && selectedTaskId) {
      interval = setInterval(() => {
        setTaskTimes(prev => ({
          ...prev,
          [selectedTaskId]: (prev[selectedTaskId] || 0) + 1
        }));
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isPlaying, selectedTaskId]);

  const currentTaskTime = selectedTaskId ? (taskTimes[selectedTaskId] || 0) : 0;

  const formatTime = (totalSeconds: number) => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    return [
      hours.toString().padStart(2, '0'),
      minutes.toString().padStart(2, '0'),
      seconds.toString().padStart(2, '0')
    ].join(':');
  };

  const canCreate = userRole === "Admin" || userRole === "PM";

  const [projects, setProjects] = useState([
    {
      id: 1,
      name: "Website Redesign",
      tasks: [
        { id: 101, name: "Frontend Development", time: "0:00", created: "06/27/2024 09:43 AM", isCompleted: false },
        { id: 102, name: "UI/UX Design", time: "2:15", created: "06/27/2024 09:41 AM", isCompleted: false },
        { id: 103, name: "Backend APIs", time: "1:05", created: "06/28/2024 10:00 AM", isCompleted: false }
      ]
    },
    {
      id: 2,
      name: "Mobile App",
      tasks: [
        { id: 201, name: "API Integration", time: "0:00", created: "06/27/2024 09:41 AM", isCompleted: false },
        { id: 202, name: "Push Notifications", time: "1:30", created: "06/27/2024 10:05 AM", isCompleted: false },
        { id: 203, name: "App Store Deployment", time: "0:00", created: "06/29/2024 11:05 AM", isCompleted: false }
      ]
    }
  ]);

  const handleProjectClick = (projectId: string) => {
    // Set the main view to show this project's tasks
    setSelectedProjectId(projectId);

    // Auto-select the first task of this project if the currently selected task isn't in it
    const project = projects.find(p => p.id === projectId);
    if (project && project.tasks.length > 0) {
      const isCurrentTaskInProject = project.tasks.some(t => t.id === selectedTaskId);
      if (!isCurrentTaskInProject) {
        setSelectedTaskId(project.tasks[0].id);
      }
    }
  };

  const handleTaskClick = (taskId: string, projectId: string) => {
    setSelectedTaskId(taskId);
    // Optionally also set the project as selected when a task is clicked directly
    setSelectedProjectId(projectId);
    // Pause timer when switching tasks
    stopBackendTimer();
  };

  const handleCompleteTask = () => {
    if (!selectedTaskId) return;

    // Reset timer for this specific task
    stopBackendTimer();
    setTaskTimes(prev => ({ ...prev, [selectedTaskId]: 0 }));

    if (token) {
      fetch(`${import.meta.env.VITE_API_BASE_URL}/tasks/${selectedTaskId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: 'Done' })
      }).catch(console.error);
    }

    // Mark task as completed and check for project completion
    setProjects(prevProjects => {
      let projectJustCompleted = false;
      
      const newProjects = prevProjects.map(proj => {
        const taskIndex = proj.tasks.findIndex(t => t.id === selectedTaskId);
        if (taskIndex !== -1) {
          const newTasks = [...proj.tasks];
          newTasks[taskIndex] = { ...newTasks[taskIndex], isCompleted: true };
          
          // Check if this project is now fully completed
          if (newTasks.every(t => t.isCompleted)) {
            projectJustCompleted = true;
          }
          
          return { ...proj, tasks: newTasks };
        }
        return proj;
      });

      if (projectJustCompleted) {
        setLastProjectCompletedAt(new Date());
      }

      return newProjects;
    });
  };

  // Get all tasks as a flat list
  const allTasks = projects.flatMap(p => p.tasks);
  
  // Get tasks for the main view based on selected project
  let displayedTasks = selectedProjectId
    ? projects.find(p => p.id === selectedProjectId)?.tasks || []
    : allTasks;
    
  if (taskFilter === 'completed') {
    displayedTasks = displayedTasks.filter(t => t.isCompleted);
  } else if (taskFilter === 'pending') {
    displayedTasks = displayedTasks.filter(t => !t.isCompleted);
  }

  // Get the fully active task object to display details
  const activeTask = allTasks.find(t => t.id === selectedTaskId);

  // Helper to check if a project is fully completed
  const isProjectComplete = (projectId: string) => {
    const proj = projects.find(p => p.id === projectId);
    if (!proj || proj.tasks.length === 0) return false;
    return proj.tasks.every(t => t.isCompleted);
  };

  const handleLogout = () => {
    localStorage.removeItem("authToken");
    localStorage.removeItem("loginTimestamp");
    
    // Automatically checkout if they were checked in
    if (activeAttendanceLogId && token) {
      fetch(`${import.meta.env.VITE_API_BASE_URL}/attendance/check-out`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ attendanceLogId: activeAttendanceLogId })
      }).catch(console.error);
    }
    
    setActiveAttendanceLogId(null);
    setCheckInTime(null);
    setIsCheckedIn(false);
    setToken(null);
    setUser(null);
    setIsAuthenticated(false);
  };

  useEffect(() => {
    const savedToken = localStorage.getItem("authToken");
    const loginTimestamp = localStorage.getItem("loginTimestamp");
    
    if (savedToken && loginTimestamp) {
      const loginDate = new Date(loginTimestamp);
      const now = new Date();
      const diffTime = Math.abs(now.getTime() - loginDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays <= 3) {
        // Token is valid, fetch user details
        fetch(`${import.meta.env.VITE_API_BASE_URL}/auth/me`, {
          headers: { 'Authorization': `Bearer ${savedToken}` }
        })
        .then(res => res.json())
        .then(data => {
          if (data && !data.error) {
            setToken(savedToken);
            setUser(data);
            let role = "Employee";
            if (data.role === 'admin' || data.role === 'SuperAdmin') role = "Admin";
            else if (data.role === 'project-manager') role = "PM";
            setUserRole(role as "Admin" | "PM" | "Employee");
            setIsAuthenticated(true);
            // Intentionally not calling fetchAttendanceStatus/fetchProjects here, 
            // as the existing isAuthenticated useEffect will handle it once state updates
          } else {
            handleLogout();
          }
        })
        .catch(err => {
          console.error("Auto-login failed:", err);
          handleLogout();
        });
      } else {
        // Expired after 3 days
        handleLogout();
      }
    }
  }, []);

  // Handle app closing -> automatic check-out
  useEffect(() => {
    const handleUnload = () => {
      if (activeAttendanceLogId && token) {
        fetch(`${import.meta.env.VITE_API_BASE_URL}/attendance/check-out`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ attendanceLogId: activeAttendanceLogId }),
          keepalive: true
        }).catch(console.error);
      }
    };
    
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [activeAttendanceLogId, token]);

  const fetchProjects = async (authToken: string, currentUserId?: string) => {
    const uid = currentUserId || user?.id;
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/projects`, {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        const mapped = data.map((p: any) => ({
          id: p.id,
          name: p.name,
          tasks: p.tasks
            .filter((t: any) => t.assigneeId === uid)
            .map((t: any) => ({
              id: t.id,
              name: t.title,
              time: formatTime(t.timeConsumed || 0),
              created: new Date(t.createdAt).toLocaleString(),
              isCompleted: t.status === 'Done'
            }))
        })).filter((p: any) => p.tasks && p.tasks.length > 0);
        setProjects(mapped);
      }
    } catch (err) {
      console.error("Failed to fetch projects", err);
    }
  };

  const fetchAttendanceStatus = async (authToken: string) => {
    if (isTransitioningRef.current) return;
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/attendance/status`, {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        setAccumulatedShiftSeconds(data.accumulatedShiftSeconds || 0);
        
        if (data.activeAttendanceLogId) {
          setActiveAttendanceLogId(data.activeAttendanceLogId);
          setCheckInTime(new Date(data.checkInTime));
          setIsCheckedIn(true);
        } else {
          setActiveAttendanceLogId(null);
          setCheckInTime(null);
          setIsCheckedIn(false);
        }
      }
    } catch (err) {
      console.error("Failed to fetch attendance status", err);
    }
  };

  useEffect(() => {
    if (isAuthenticated && token && user) {
      // Fetch once on mount/auth
      fetchAttendanceStatus(token);
      
      const interval = setInterval(() => {
        fetchProjects(token, user.id);
        fetchAttendanceStatus(token);
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [isAuthenticated, token, user]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsAuthLoading(true);
    const form = e.target as HTMLFormElement;

    if (authMode === 'signup') {
      const fullName = (form.querySelector('input[name="fullname"]') as HTMLInputElement).value;
      const email = (form.querySelector('input[name="email"]') as HTMLInputElement).value;
      const password = (form.querySelector('input[name="password"]') as HTMLInputElement).value;
      const confirmPassword = (form.querySelector('input[name="confirmPassword"]') as HTMLInputElement).value;

      if (password !== confirmPassword) {
        alert("Passwords do not match!");
        setIsAuthLoading(false);
        return;
      }

      const [firstName, ...rest] = fullName.split(' ');
      
      try {
        const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/auth/signup/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ firstName, lastName: rest.join(' ') || 'User', email, password })
        });
        const data = await res.json();
        if (res.ok) {
          setSignupEmail(email);
          setAuthMode('otp');
        } else {
          alert(data.error || "Signup request failed");
        }
      } catch (err) {
        alert("Network error connecting to backend");
      } finally {
        setIsAuthLoading(false);
      }
      return;
    }

    if (authMode === 'otp') {
      const otp = (form.querySelector('input[name="otp"]') as HTMLInputElement).value;
      try {
        const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/auth/signup/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: signupEmail, otp })
        });
        const data = await res.json();
        if (res.ok) {
          alert(data.message || "Verified successfully! Waiting for Admin approval.");
          setAuthMode('login');
        } else {
          alert(data.error || "OTP Verification failed");
        }
      } catch (err) {
        alert("Network error connecting to backend");
      } finally {
        setIsAuthLoading(false);
      }
      return;
    }
    if (authMode === 'forgot-password') {
      const email = (form.querySelector('input[name="email"]') as HTMLInputElement).value;
      try {
        const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/auth/forgot-password/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (res.ok) {
          setSignupEmail(email); // Reusing this state for the reset email
          setAuthMode('reset-password');
        } else {
          alert(data.error || "Failed to request reset");
        }
      } catch (err) {
        alert("Network error connecting to backend");
      } finally {
        setIsAuthLoading(false);
      }
      return;
    }

    if (authMode === 'reset-password') {
      const otp = (form.querySelector('input[name="otp"]') as HTMLInputElement).value;
      const newPassword = (form.querySelector('input[name="newPassword"]') as HTMLInputElement).value;
      const confirmPassword = (form.querySelector('input[name="confirmPassword"]') as HTMLInputElement).value;

      if (newPassword !== confirmPassword) {
        alert("Passwords do not match!");
        setIsAuthLoading(false);
        return;
      }

      try {
        const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/auth/forgot-password/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: signupEmail, otp, newPassword })
        });
        const data = await res.json();
        if (res.ok) {
          alert(data.message || "Password reset successfully!");
          setAuthMode('login');
        } else {
          alert(data.error || "Reset failed");
        }
      } catch (err) {
        alert("Network error connecting to backend");
      } finally {
        setIsAuthLoading(false);
      }
      return;
    }

    // Login flow
    try {
      const email = (form.querySelector('input[name="email"]') as HTMLInputElement).value;
      const password = (form.querySelector('input[name="password"]') as HTMLInputElement).value;

      const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      
      if (res.ok && data.token) {
        localStorage.setItem("authToken", data.token);
        localStorage.setItem("loginTimestamp", new Date().toISOString());
        
        setToken(data.token);
        setUser(data.employee);
        
        let role = "Employee";
        if (data.employee.role === 'admin' || data.employee.role === 'SuperAdmin') role = "Admin";
        else if (data.employee.role === 'project-manager') role = "PM";
        
        setUserRole(role as "Admin" | "PM" | "Employee");
        setIsAuthenticated(true);
        fetchProjects(data.token, data.employee.id);
        fetchAttendanceStatus(data.token);
      } else {
        alert(data.error || "Authentication failed");
      }
    } catch (err) {
      alert("Network error connecting to backend");
    } finally {
      setIsAuthLoading(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="auth-screen">
        <div className="auth-sidebar">
           <h1>NUVIO</h1>
           <p>The modern workspace for high-performing teams to track time, manage projects, and stay aligned.</p>
        </div>
        <div className="auth-content">
          <div className="auth-card">
            <h2>
              {authMode === 'login' ? 'Welcome Back' : 
               authMode === 'signup' ? 'Create Account' : 
               authMode === 'forgot-password' ? 'Reset Password' : 
               authMode === 'reset-password' ? 'New Password' : 'Verify Email'}
            </h2>
            
            {authMode === 'otp' && <p style={{ color: '#666', fontSize: '13px', marginBottom: '25px', lineHeight: 1.5 }}>An OTP has been sent to <strong>{signupEmail}</strong>. Please enter it below.</p>}
            {authMode === 'forgot-password' && <p style={{ color: '#666', fontSize: '13px', marginBottom: '25px', lineHeight: 1.5 }}>Enter your email address and we'll send you a code to reset your password.</p>}
            {authMode === 'reset-password' && <p style={{ color: '#666', fontSize: '13px', marginBottom: '25px', lineHeight: 1.5 }}>An OTP has been sent to <strong>{signupEmail}</strong>.</p>}

            <form className="auth-form" onSubmit={handleAuthSubmit}>
              {authMode === 'signup' && (
                <>
                  <div className="auth-input-group">
                    <label>Full Name</label>
                    <input type="text" name="fullname" placeholder="John Doe" required />
                  </div>
                  <div className="auth-input-group">
                    <label>Email</label>
                    <input type="email" name="email" placeholder="you@example.com" required />
                  </div>
                  <div className="auth-input-group">
                    <label>Password</label>
                    <input type="password" name="password" placeholder="••••••••" required />
                  </div>
                  <div className="auth-input-group">
                    <label>Confirm Password</label>
                    <input type="password" name="confirmPassword" placeholder="••••••••" required />
                  </div>
                </>
              )}
              
              {authMode === 'login' && (
                <>
                  <div className="auth-input-group">
                    <label>Email</label>
                    <input type="email" name="email" placeholder="you@example.com" required />
                  </div>
                  <div className="auth-input-group">
                    <label>Password</label>
                    <input type="password" name="password" placeholder="••••••••" required />
                    <div style={{ textAlign: 'right', marginTop: '2px' }}>
                      <button type="button" onClick={() => setAuthMode('forgot-password')} style={{ background: 'none', border: 'none', color: '#666', fontSize: '11px', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>
                        Forgot Password?
                      </button>
                    </div>
                  </div>
                </>
              )}

              {authMode === 'forgot-password' && (
                <div className="auth-input-group">
                  <label>Email</label>
                  <input type="email" name="email" placeholder="you@example.com" required />
                </div>
              )}

              {authMode === 'reset-password' && (
                <>
                  <div className="auth-input-group">
                    <label>6-Digit OTP</label>
                    <input type="text" name="otp" placeholder="123456" maxLength={6} required style={{ letterSpacing: '4px', textAlign: 'center', fontSize: '16px', fontWeight: 600 }} />
                  </div>
                  <div className="auth-input-group">
                    <label>New Password</label>
                    <input type="password" name="newPassword" placeholder="••••••••" required />
                  </div>
                  <div className="auth-input-group">
                    <label>Confirm New Password</label>
                    <input type="password" name="confirmPassword" placeholder="••••••••" required />
                  </div>
                </>
              )}

              {authMode === 'otp' && (
                <div className="auth-input-group">
                  <label>6-Digit OTP</label>
                  <input type="text" name="otp" placeholder="123456" maxLength={6} required style={{ letterSpacing: '8px', textAlign: 'center', fontSize: '24px', fontWeight: 700 }} />
                </div>
              )}

              <button type="submit" className="btn-auth-submit" disabled={isAuthLoading}>
                {isAuthLoading ? 'Please wait...' : 
                 (authMode === 'login' ? 'Log In' : 
                  authMode === 'signup' ? 'Sign Up' : 
                  authMode === 'forgot-password' ? 'Send Code' : 
                  authMode === 'reset-password' ? 'Reset Password' : 'Verify OTP')}
              </button>
            </form>
            
            {(authMode === 'login' || authMode === 'signup') && (
              <div className="auth-toggle">
                {authMode === 'login' ? "Don't have an account?" : "Already have an account?"}
                <button type="button" onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}>
                  {authMode === 'login' ? 'Sign up' : 'Log in'}
                </button>
              </div>
            )}
            
            {(authMode === 'otp' || authMode === 'forgot-password' || authMode === 'reset-password') && (
              <div className="auth-toggle">
                <button type="button" onClick={() => setAuthMode('login')} style={{ marginLeft: 0 }}>
                  Back to Log in
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!isCheckedIn) {
    return (
      <div className="pre-checkin-screen-centered">
        <div className="checkin-logo-container">
            <div className="checkin-logo-circle"></div>
            <span className="checkin-logo-text">NUVIO</span>
        </div>
        
        <div className="checkin-clock-container">
          <div className="checkin-clock-time">{formatTimeOnly(currentRealTime)}</div>
          <div className="checkin-clock-ampm">{formatAmPm(currentRealTime)}</div>
        </div>

        <div className="checkin-divider"></div>
        
        <div className="checkin-stats">
          <div className="checkin-stats-label">TOTAL WORKED TODAY</div>
          <div className="checkin-stats-value">{formatTime(accumulatedShiftSeconds)}</div>
        </div>

        <button className="btn-checkin-new" onClick={handleCheckIn}>
          CHECK-IN
        </button>

        <button 
          className="btn-checkin-logout"
          onClick={async () => {
            if (token) {
              try {
                await fetch(`${import.meta.env.VITE_API_BASE_URL}/auth/logout`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${token}` }
                });
              } catch (e) {
                console.error("Failed to notify backend of logout");
              }
            }
            localStorage.removeItem("authToken");
            localStorage.removeItem("loginTimestamp");
            setToken(null);
            setUser(null);
            setIsAuthenticated(false);
          }}
        >
          LOGOUT
        </button>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Top Navbar */}
      <header className="top-navbar">
        <div className="navbar-left">
          <span className="logo-text">Nuvio</span>
        </div>
        <div className="navbar-right">
          <span className="nav-time">{formatRealTime(currentRealTime)}</span>
          <button className="btn-checkout-top" onClick={handleCheckOut}>Check-out</button>
          <div className="nav-avatar" style={{ position: 'relative', cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setIsAvatarMenuOpen(!isAvatarMenuOpen); }}>
             <img src={`https://ui-avatars.com/api/?name=${user ? `${user.firstName}+${user.lastName}` : 'Mithun+Raj'}&background=random`} alt="Avatar" />
             {isAvatarMenuOpen && (
               <div style={{
                 position: 'absolute',
                 right: 0,
                 top: '100%',
                 marginTop: '8px',
                 backgroundColor: 'white',
                 border: '1px solid var(--border-color)',
                 borderRadius: '6px',
                 boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                 zIndex: 100,
                 minWidth: '200px'
               }}>
                  <div 
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (token) {
                        const url = `https://gc-pro.vercel.app/login?token=${token}`;
                        try {
                          if (isTauri()) {
                            await openUrl(url);
                          } else {
                            window.open(url, '_blank');
                          }
                        } catch (err) {
                          console.error("Failed to open URL:", err);
                          window.open(url, '_blank');
                        }
                      } else {
                        alert("Session token is missing. Please log in again.");
                      }
                      setIsAvatarMenuOpen(false);
                    }}
                    style={{ 
                      padding: '12px 16px', 
                      cursor: 'pointer', 
                      fontSize: '13px', 
                      fontWeight: 500,
                      color: 'var(--text-dark)'
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f1f3f4')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    Open Web Dashboard
                  </div>
               </div>
             )}
          </div>
        </div>
      </header>

      <div className="main-layout">
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="user-profile-section">
            <div className="profile-pic">
               <img src={`https://ui-avatars.com/api/?name=${user ? `${user.firstName}+${user.lastName}` : 'Mithun+Raj'}&background=e0e0e0&color=333&size=128`} alt="Profile" />
            </div>
            <h2 className="profile-name">{user ? `${user.firstName} ${user.lastName}` : "Mithun Raj"}</h2>
            <p className="profile-role">{userRole === 'Employee' ? 'Employee' : userRole}</p>
          </div>

          <div className="timer-section">
            <div className="timer-display-box">
              {formatTime(currentTaskTime)}
            </div>
            <p className="active-task-name">
              {activeTask ? activeTask.name : 'No task selected'}
            </p>
            {activeTask?.isCompleted ? (
              <div style={{ padding: '10px', backgroundColor: '#d4edda', color: '#155724', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '48px', height: '48px', marginBottom: '15px' }}>
                 <Check size={24} />
              </div>
            ) : (
              <button className="play-button-square" onClick={() => isPlaying ? stopBackendTimer() : (selectedTaskId && startBackendTimer(selectedTaskId))}>
                {isPlaying ? <Pause size={24} fill="white" /> : <Play size={24} fill="white" />}
              </button>
            )}
            
            <div className="timer-stats">
              <span>No limits</span>
              <span title="Total Worked Time">Today: {formatTime(totalWorkedSeconds)}</span>
            </div>
          </div>

          <div className="search-bar-sidebar">
            <Search size={14} color="var(--text-gray)" />
            <input type="text" placeholder="adm" defaultValue="adm" />
          </div>

          <div className="project-section">
            <div className="project-section-title">
              Assigned Projects
            </div>
            
            {projects.map(project => {
              const isCompleted = isProjectComplete(project.id);
              const isSelected = selectedProjectId === project.id;

              return (
                <div 
                  key={project.id}
                  className={`project-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleProjectClick(project.id)}
                >
                  <span>{project.name}</span>
                  {isSelected && !isCompleted && <Check size={16} color="#000" />}
                  {isCompleted && <Check size={16} color="#28a745" />}
                </div>
              );
            })}
          </div>
        </aside>

        {/* Main Content */}
        <main className="main-content">
          <div className="main-header-new">
            <div className="header-top-new">
              <h1>To-dos</h1>
              <div style={{ position: 'relative' }}>
                <MoreVertical 
                  size={20} 
                  color="var(--text-gray)" 
                  style={{ cursor: 'pointer' }} 
                  onClick={(e) => { e.stopPropagation(); setIsMenuOpen(!isMenuOpen); }}
                />
                {isMenuOpen && (
                  <div style={{ 
                    position: 'absolute', 
                    right: 0, 
                    top: '100%', 
                    marginTop: '8px', 
                    backgroundColor: 'white', 
                    border: '1px solid var(--border-color)', 
                    borderRadius: '6px', 
                    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                    zIndex: 100,
                    minWidth: '150px'
                  }}>
                    <div 
                      onClick={() => { setTaskFilter('all'); setIsMenuOpen(false); }}
                      style={{ padding: '12px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: taskFilter === 'all' ? 700 : 500, color: 'var(--text-dark)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f1f3f4')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                    >All Tasks</div>
                    <div 
                      onClick={() => { setTaskFilter('completed'); setIsMenuOpen(false); }}
                      style={{ padding: '12px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: taskFilter === 'completed' ? 700 : 500, color: 'var(--text-dark)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f1f3f4')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                    >Completed Tasks</div>
                    <div 
                      onClick={() => { setTaskFilter('pending'); setIsMenuOpen(false); }}
                      style={{ padding: '12px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: taskFilter === 'pending' ? 700 : 500, color: 'var(--text-dark)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f1f3f4')}
                      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                    >Pending Tasks</div>
                  </div>
                )}
              </div>
            </div>
            <div className="header-subtitle-new">
              {userRole === 'Employee' ? 'Employee' : userRole} View
            </div>
          </div>

          {selectedProjectId ? (
            <div className="todo-list-container">
              <table className="todo-table">
                <thead>
                  <tr>
                    <th>To-do</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedTasks.map(task => {
                    const isSelected = selectedTaskId === task.id;
                    
                    let rowClass = "todo-row";
                    if (isSelected) rowClass += " active";
                    
                    let rowStyle = {};
                    if (task.isCompleted) {
                      rowStyle = { backgroundColor: '#d4edda', color: '#155724' };
                    }

                    return (
                      <tr 
                        key={task.id} 
                        className={rowClass}
                        style={rowStyle}
                        onClick={() => {
                          const proj = projects.find(p => p.tasks.some(t => t.id === task.id));
                          if (proj) handleTaskClick(task.id, proj.id);
                        }}
                      >
                        <td className="todo-title-cell">
                          {task.isCompleted ? (
                            <Check size={16} color="#28a745" style={{ marginLeft: isSelected ? 0 : 16 }} />
                          ) : isSelected ? (
                            isPlaying ? (
                              <Pause 
                                size={16} 
                                fill="var(--primary-blue)" 
                                className="play-icon" 
                                style={{ color: 'var(--primary-blue)', cursor: 'pointer' }} 
                                onClick={(e) => { e.stopPropagation(); stopBackendTimer(); }}
                              />
                            ) : (
                              <Play 
                                size={16} 
                                fill="var(--primary-blue)" 
                                className="play-icon" 
                                style={{ color: 'var(--primary-blue)', cursor: 'pointer' }} 
                                onClick={(e) => { e.stopPropagation(); startBackendTimer(task.id); }}
                              />
                            )
                          ) : (
                            <div style={{ width: 16, height: 16, marginLeft: 16 }}></div>
                          )}
                          <span style={{ 
                            textDecoration: task.isCompleted ? 'line-through' : 'none',
                            color: task.isCompleted ? '#28a745' : 'inherit'
                          }}>
                            {task.name}
                          </span>
                        </td>
                        <td>{task.created}</td>
                      </tr>
                    );
                  })}
                  {displayedTasks.length === 0 && (
                    <tr>
                      <td colSpan={2} style={{ textAlign: 'center', color: 'var(--text-gray)', padding: '20px' }}>No tasks found.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="select-task-placeholder">
               <div className="select-task-box">
                  <div className="box-header">
                    <h3>Select a task</h3>
                  </div>
                  <div className="box-content">
                     <div className="icon-wrapper">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-gray)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
                     </div>
                     <p>Select a project to see available sub-tasks.</p>
                  </div>
               </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
