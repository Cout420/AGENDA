/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import { format, subMonths, addMonths, startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval, isSameMonth, isSameDay, addMinutes } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, List, Search, Plus, Calendar as CalendarIcon, MapPin, X, LogOut, LogIn } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { auth, db } from './firebase';
import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, User } from 'firebase/auth';
import { collection, query, where, onSnapshot, addDoc, deleteDoc, doc, serverTimestamp, updateDoc } from 'firebase/firestore';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Event = {
  id: string;
  userId: string;
  date: string;
  title: string;
  isAllDay: boolean;
  startTime?: string;
  endTime?: string;
  duration?: number;
  location?: string;
  type: 'allday' | 'timed';
};

const calculateEndTime = (startTime: string, durationMinutes: number) => {
  const [hours, minutes] = startTime.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  const endDate = addMinutes(date, durationMinutes);
  return format(endDate, 'HH:mm');
};

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    tenantId?: string | null;
    providerInfo?: any[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function QuickAddModal({ isOpen, onClose, onAdd, selectedDate, dayEvents }: { isOpen: boolean, onClose: () => void, onAdd: (e: Omit<Event, 'id' | 'userId'>) => void, selectedDate: Date, dayEvents: Event[] }) {
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(60);
  const [startTime, setStartTime] = useState('09:00');
  const [isAllDay, setIsAllDay] = useState(false);

  const timeToMinutes = (time: string) => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  };

  const getEventMinutes = (start: string, end: string) => {
    const startMins = timeToMinutes(start);
    let endMins = timeToMinutes(end);
    if (endMins <= startMins) endMins += 24 * 60;
    return { startMins, endMins };
  };

  const occupiedSlots = useMemo(() => {
    return dayEvents
      .filter(e => !e.isAllDay && e.startTime && e.endTime)
      .map(e => ({
        start: e.startTime!,
        end: e.endTime!,
        title: e.title
      }))
      .sort((a, b) => a.start.localeCompare(b.start));
  }, [dayEvents]);

  const isTimeConflict = (time: string, durationMins: number) => {
    const newStartMins = timeToMinutes(time);
    const newEndMins = newStartMins + durationMins;

    return occupiedSlots.some(slot => {
      const { startMins, endMins } = getEventMinutes(slot.start, slot.end);
      return newStartMins < endMins && startMins < newEndMins;
    });
  };

  const hasConflict = useMemo(() => {
    if (isAllDay) return false;
    return isTimeConflict(startTime, duration);
  }, [startTime, duration, isAllDay, occupiedSlots]);

  const timeOptions = useMemo(() => {
    const options = [];
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 15) {
        const hh = h.toString().padStart(2, '0');
        const mm = m.toString().padStart(2, '0');
        options.push(`${hh}:${mm}`);
      }
    }
    return options;
  }, []);

  useEffect(() => {
    if (isOpen && !isAllDay && hasConflict) {
      const available = timeOptions.find(t => !isTimeConflict(t, duration));
      if (available) {
        setStartTime(available);
      }
    }
  }, [isOpen, duration, isAllDay, hasConflict, timeOptions]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || (hasConflict && !isAllDay)) return;

    const newEvent: Omit<Event, 'id' | 'userId'> = {
      date: format(selectedDate, 'yyyy-MM-dd'),
      title,
      isAllDay,
      type: isAllDay ? 'allday' : 'timed',
      ...(isAllDay ? {} : {
        startTime,
        duration,
        endTime: calculateEndTime(startTime, duration),
      })
    };
    
    onAdd(newEvent);
    onClose();
    setTitle('');
    setIsAllDay(false);
    setStartTime('09:00');
    setDuration(60);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-3xl sm:rounded-3xl w-full max-w-md overflow-hidden shadow-2xl transform transition-all flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center shrink-0">
          <h2 className="text-xl font-bold text-gray-900">Novo Compromisso</h2>
          <button onClick={onClose} className="p-2 bg-gray-100 rounded-full text-gray-500 hover:bg-gray-200 transition-colors"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto p-6">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <input 
                required 
                autoFocus
                type="text" 
                value={title} 
                onChange={e => setTitle(e.target.value)} 
                className="w-full text-xl font-semibold border-0 border-b-2 border-gray-200 focus:border-[#ff4d4d] focus:ring-0 px-0 py-2 placeholder-gray-400 bg-transparent transition-colors outline-none" 
                placeholder="O que você vai fazer?" 
              />
            </div>
            
            <div className="flex items-center justify-between bg-gray-50 p-4 rounded-2xl">
              <span className="font-medium text-gray-700">Dia Inteiro</span>
              <label className="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" checked={isAllDay} onChange={e => setIsAllDay(e.target.checked)} className="sr-only peer" />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#ff4d4d]"></div>
              </label>
            </div>

            {!isAllDay && (
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-50 p-4 rounded-2xl">
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Início</label>
                  <select 
                    required 
                    value={startTime} 
                    onChange={e => setStartTime(e.target.value)} 
                    className="w-full bg-transparent text-lg font-bold text-gray-900 focus:outline-none cursor-pointer" 
                  >
                    {timeOptions.map(time => {
                      const conflict = isTimeConflict(time, duration);
                      return (
                        <option key={time} value={time} disabled={conflict}>
                          {time}
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div className="bg-gray-50 p-4 rounded-2xl">
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Duração</label>
                  <select 
                    required 
                    value={duration} 
                    onChange={e => setDuration(Number(e.target.value))} 
                    className="w-full bg-transparent text-lg font-bold text-gray-900 focus:outline-none cursor-pointer" 
                  >
                    <option value={15}>15 min</option>
                    <option value={30}>30 min</option>
                    <option value={45}>45 min</option>
                    <option value={60}>1 hora</option>
                    <option value={90}>1.5 horas</option>
                    <option value={120}>2 horas</option>
                    <option value={180}>3 horas</option>
                    <option value={240}>4 horas</option>
                  </select>
                </div>
              </div>
            )}

            <button 
              type="submit" 
              disabled={hasConflict && !isAllDay}
              className={cn(
                "w-full font-bold text-lg py-4 rounded-2xl mt-6 transition-all",
                (hasConflict && !isAllDay)
                  ? "opacity-50 cursor-not-allowed bg-[#ff4d4d] text-white shadow-lg shadow-red-500/30"
                  : "bg-[#ff4d4d] hover:bg-red-600 text-white shadow-lg shadow-red-500/30"
              )}
            >
              Adicionar à Agenda
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [events, setEvents] = useState<Event[]>([]);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  const [touchStartX, setTouchStartX] = useState<number | null>(null);
  const [touchEndX, setTouchEndX] = useState<number | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAuthReady || !user) {
      setEvents([]);
      return;
    }

    let q;
    if (user.email === 'cout@agenda.local') {
      q = query(collection(db, 'events'));
    } else {
      q = query(collection(db, 'events'), where('userId', '==', user.uid));
    }

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const loadedEvents: Event[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        
        // Migrate old events to COUT
        if (user.email === 'cout@agenda.local' && data.userId !== user.uid) {
          updateDoc(doc(db, 'events', docSnap.id), {
            userId: user.uid
          }).catch(err => console.error("Migration error:", err));
        }
        
        loadedEvents.push({ id: docSnap.id, ...data } as Event);
      });
      setEvents(loadedEvents);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'events');
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    const email = `${username.trim().toLowerCase()}@agenda.local`;

    try {
      if (isRegistering) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (error: any) {
      console.error("Auth error:", error);
      let errorMessage = "Ocorreu um erro na autenticação.";
      if (error.code === 'auth/invalid-credential') {
        errorMessage = "Usuário ou senha incorretos.";
      } else if (error.code === 'auth/email-already-in-use') {
        errorMessage = "Este usuário já existe. Tente fazer login.";
      } else if (error.code === 'auth/weak-password') {
        errorMessage = "A senha deve ter pelo menos 6 caracteres.";
      } else if (error.code === 'auth/operation-not-allowed') {
        errorMessage = "O login por Email/Senha não está ativado no Firebase. Siga as instruções no chat para ativar.";
      } else if (error.message) {
        errorMessage = error.message;
      }
      setLoginError(errorMessage);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Logout error:", error);
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    setTouchEndX(null);
    setTouchStartX(e.targetTouches[0].clientX);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    setTouchEndX(e.targetTouches[0].clientX);
  };

  const handleTouchEnd = () => {
    if (!touchStartX || !touchEndX) return;
    const distance = touchStartX - touchEndX;
    const isLeftSwipe = distance > 50;
    const isRightSwipe = distance < -50;

    if (isLeftSwipe) {
      setCurrentDate(prev => addMonths(prev, 1));
    }
    if (isRightSwipe) {
      setCurrentDate(prev => subMonths(prev, 1));
    }
  };

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart);
  const endDate = endOfWeek(monthEnd);
  const days = eachDayOfInterval({ start: startDate, end: endDate });

  const rows: Date[][] = [];
  let daysInWeek: Date[] = [];
  days.forEach((day) => {
    daysInWeek.push(day);
    if (daysInWeek.length === 7) {
      rows.push(daysInWeek);
      daysInWeek = [];
    }
  });

  const selectedDayEvents = useMemo(() => {
    const dateStr = format(selectedDate, 'yyyy-MM-dd');
    return events.filter(e => e.date === dateStr).sort((a, b) => {
      if (a.isAllDay && !b.isAllDay) return -1;
      if (!a.isAllDay && b.isAllDay) return 1;
      if (a.startTime && b.startTime) return a.startTime.localeCompare(b.startTime);
      return 0;
    });
  }, [events, selectedDate]);

  const handleAddEvent = async (newEventData: Omit<Event, 'id' | 'userId'>) => {
    if (!user) return;
    try {
      await addDoc(collection(db, 'events'), {
        ...newEventData,
        userId: user.uid,
        createdAt: serverTimestamp()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'events');
    }
  };

  const handleDeleteEvent = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'events', id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `events/${id}`);
    }
  };

  const getDayLoad = (date: Date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    const dayEvents = events.filter(e => e.date === dateStr);
    
    const hasAllDay = dayEvents.some(e => e.isAllDay);
    const timedEvents = dayEvents.filter(e => !e.isAllDay);
    
    const totalMinutes = timedEvents.reduce((acc, curr) => acc + (curr.duration || 0), 0);
    const MAX_MINUTES = 480; // 8 hours
    
    const loadPercentage = Math.min((totalMinutes / MAX_MINUTES) * 100, 100);
    const isFull = totalMinutes >= MAX_MINUTES;

    return { hasAllDay, loadPercentage, isFull };
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center font-sans">
        <div className="w-8 h-8 border-4 border-[#ff4d4d] border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center font-sans p-4">
        <div className="bg-white p-8 rounded-3xl shadow-xl max-w-sm w-full text-center">
          <div className="w-16 h-16 bg-red-100 text-[#ff4d4d] rounded-2xl flex items-center justify-center mx-auto mb-6">
            <CalendarIcon className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-extrabold text-gray-900 mb-2">Agenda Inteligente</h1>
          <p className="text-gray-500 mb-6">Entre com seu usuário para acessar sua agenda.</p>
          
          <form onSubmit={handleAuth} className="space-y-4">
            <div>
              <input
                type="text"
                required
                placeholder="Nome de Usuário (ex: COUT)"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-[#ff4d4d] focus:ring-2 focus:ring-red-200 outline-none transition-all"
              />
            </div>
            <div>
              <input
                type="password"
                required
                placeholder="Senha"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-[#ff4d4d] focus:ring-2 focus:ring-red-200 outline-none transition-all"
              />
            </div>

            <button
              type="submit"
              className="w-full bg-[#ff4d4d] hover:bg-red-600 text-white font-bold text-lg py-3 rounded-xl transition-colors shadow-lg shadow-red-500/30"
            >
              {isRegistering ? 'Criar Conta' : 'Entrar'}
            </button>
          </form>

          <div className="mt-6 text-sm text-gray-500">
            {isRegistering ? 'Já tem uma conta?' : 'Ainda não tem uma conta?'}
            <button
              onClick={() => { setIsRegistering(!isRegistering); setLoginError(null); }}
              className="ml-1 text-[#ff4d4d] font-bold hover:underline"
            >
              {isRegistering ? 'Faça login' : 'Criar agora'}
            </button>
          </div>

          {loginError && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl text-left">
              <strong>Erro:</strong> {loginError}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 flex justify-center font-sans selection:bg-red-200">
      <div className="w-full max-w-md bg-white min-h-screen shadow-2xl flex flex-col relative overflow-hidden">
        
        {/* Top Bar */}
        <div className="flex items-center justify-between px-4 py-3 bg-white">
          <div className="flex items-center bg-gray-100 rounded-full p-1">
            <button 
              onClick={() => setCurrentDate(prev => subMonths(prev, 1))}
              className="p-1.5 rounded-full hover:bg-white hover:shadow-sm transition-all text-gray-600"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <span className="text-[16px] font-bold px-3 text-gray-800 tracking-wide">
              {format(currentDate, 'yyyy')}
            </span>
            <button 
              onClick={() => setCurrentDate(prev => addMonths(prev, 1))}
              className="p-1.5 rounded-full hover:bg-white hover:shadow-sm transition-all text-gray-600"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
          <div className="flex items-center gap-4">
            <button onClick={handleLogout} className="hover:opacity-70 transition-opacity text-gray-500" title="Sair">
              <LogOut className="w-5 h-5" />
            </button>
            <button onClick={() => setIsAddModalOpen(true)} className="hover:opacity-70 transition-opacity"><Plus className="w-7 h-7 text-gray-900" /></button>
          </div>
        </div>

        {/* Header */}
        <div className="px-4 pt-2 pb-4 flex items-baseline gap-3">
          <h1 className="text-4xl font-extrabold capitalize text-gray-900 tracking-tight">
            {format(currentDate, 'MMMM', { locale: ptBR })}
          </h1>
          <h2 className="text-3xl font-extrabold text-gray-900 tracking-tight">
            Agenda do dia 🔥
          </h2>
        </div>

        {/* Calendar Grid */}
        <div 
          className="px-2"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div className="grid grid-cols-7 mb-2">
            {['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((day, i) => (
              <div key={i} className="text-center text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                {day}
              </div>
            ))}
          </div>
          
          <div className="flex flex-col border-t border-gray-100">
            {rows.map((week, i) => (
              <div key={i} className="grid grid-cols-7 border-b border-gray-100">
                {week.map((day, j) => {
                  const { hasAllDay, loadPercentage, isFull } = getDayLoad(day);
                  const isSelected = isSameDay(day, selectedDate);
                  const isCurrentMonth = isSameMonth(day, monthStart);
                  
                  return (
                    <div 
                      key={j} 
                      onClick={() => {
                        setSelectedDate(day);
                        if (!isCurrentMonth) setCurrentDate(day);
                      }}
                      className="flex flex-col items-center justify-start py-2 h-16 cursor-pointer hover:bg-gray-50 transition-colors"
                    >
                      <div className={cn(
                        "w-9 h-9 flex items-center justify-center rounded-full text-[17px] font-bold transition-all",
                        !isCurrentMonth ? "text-gray-300" : "text-gray-900",
                        isSelected && "bg-[#ff4d4d] text-white shadow-md shadow-red-500/30",
                        isFull && !isSelected && "text-[#ff4d4d]"
                      )}>
                        {format(day, 'd')}
                      </div>
                      
                      <div className="flex items-center justify-center h-1.5 mt-1 gap-1 w-full px-2">
                        {hasAllDay && <div className="w-1.5 h-1.5 rounded-full bg-[#5bc0de] shrink-0" />}
                        {loadPercentage > 0 && (
                          <div className="h-1.5 bg-[#f0ad4e] rounded-full transition-all duration-500" style={{ width: `${Math.max(20, loadPercentage)}%`, maxWidth: '24px' }} />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Agenda List */}
        <div className="flex-1 overflow-y-auto px-4 py-2 pb-20">
          {selectedDayEvents.length === 0 ? (
            <div className="text-center text-gray-500 mt-10 font-medium">Nenhum compromisso neste dia.</div>
          ) : (
            selectedDayEvents.map(event => (
              <div key={event.id} className="flex items-center py-4 border-b border-gray-100 last:border-0 relative pl-4 hover:bg-gray-50 transition-colors rounded-xl group">
                {event.isAllDay ? (
                  <>
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-[#5bc0de] flex items-center justify-center text-white">
                      <CalendarIcon className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex-1 ml-8">
                      <h3 className="text-[17px] font-bold text-gray-900">{event.title}</h3>
                    </div>
                    <div className="text-[15px] text-gray-500 pr-2 font-medium">dia inteiro</div>
                  </>
                ) : (
                  <>
                    <div className="absolute left-0 top-3 bottom-3 w-1.5 bg-[#f0ad4e] rounded-r-md" />
                    <div className="flex-1 ml-4">
                      <h3 className="text-[17px] font-bold text-gray-900 leading-tight">{event.title}</h3>
                      {event.location && (
                        <div className="flex items-center text-[13px] text-gray-400 mt-1 uppercase tracking-wide font-semibold">
                          <MapPin className="w-3.5 h-3.5 mr-1" />
                          {event.location}
                        </div>
                      )}
                    </div>
                    <div className="text-right flex flex-col justify-center pr-2">
                      <div className="text-[15px] font-bold text-gray-900">{event.startTime}</div>
                      <div className="text-[15px] font-bold text-gray-400">{event.endTime}</div>
                    </div>
                  </>
                )}
                <button 
                  onClick={(e) => handleDeleteEvent(event.id, e)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                  title="Excluir"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Add Modal */}
        <QuickAddModal 
          isOpen={isAddModalOpen} 
          onClose={() => setIsAddModalOpen(false)} 
          onAdd={handleAddEvent}
          selectedDate={selectedDate}
          dayEvents={selectedDayEvents}
        />
      </div>
    </div>
  );
}


