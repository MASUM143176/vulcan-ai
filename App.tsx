
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Message, Role, PersonaConfig, AppMode, ChatThread } from './types';
import { vulcanService, encodePCM, decodePCM, decodeAudioData } from './services/geminiService';
import ChatMessage from './components/ChatMessage';
import Header from './components/Header';
import VoiceOverlay from './components/VoiceOverlay';

const STORAGE_KEY = 'VULCAN_PLATFORM_DATA_V1';

const MODE_DEFAULTS: Record<AppMode, Partial<PersonaConfig>> = {
  roast: { sarcasm: 98, edge: 95 },
  girlfriend: { sarcasm: 30, edge: 10 },
  boyfriend: { sarcasm: 20, edge: 10 },
  mentor: { sarcasm: 5, edge: 5 },
  scientist: { sarcasm: 0, edge: 20 },
  coder: { sarcasm: 10, edge: 10 }
};

const App: React.FC = () => {
  const [threads, setThreads] = useState<ChatThread[]>([
    { id: 'initial', title: 'New Roast', messages: [], mode: 'roast', lastUpdate: Date.now() }
  ]);
  const [activeThreadId, setActiveThreadId] = useState<string>('initial');
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [userVolume, setUserVolume] = useState(0);
  const [transcriptions, setTranscriptions] = useState({ input: '', output: '' });
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false); 
  
  // Search and Filter States
  const [threadSearchQuery, setThreadSearchQuery] = useState('');
  const [messageSearchQuery, setMessageSearchQuery] = useState('');
  const [showOnlyFavorites, setShowOnlyFavorites] = useState(false);
  const [isSearchingInChat, setIsSearchingInChat] = useState(false);

  const [persona, setPersona] = useState<PersonaConfig>({ 
    mode: 'roast', sarcasm: 98, edge: 95, language: "Auto", 
    fastReply: false, useSearch: false, useMaps: false 
  });
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [theme, setTheme] = useState<'neon' | 'obsidian'>('neon');
  const [attachments, setAttachments] = useState<string[]>([]);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const liveSessionRef = useRef<any>(null);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.threads && parsed.threads.length > 0) {
          setThreads(parsed.threads);
          setActiveThreadId(parsed.activeThreadId || parsed.threads[0].id);
        }
        if (parsed.persona) setPersona(parsed.persona);
        if (parsed.theme) setTheme(parsed.theme);
      } catch (e) { console.error("Load state failed", e); }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ threads, activeThreadId, persona, theme }));
  }, [threads, activeThreadId, persona, theme]);

  const activeThread = threads.find(t => t.id === activeThreadId) || threads[0] || {
    id: 'fallback', title: 'Fallback', messages: [], mode: 'roast', lastUpdate: Date.now()
  };

  const createNewChat = () => {
    const id = Math.random().toString(36).substring(7);
    const newThread: ChatThread = { 
      id, title: 'New Session', messages: [], mode: persona.mode, lastUpdate: Date.now() 
    };
    setThreads([newThread, ...threads]);
    setActiveThreadId(id);
    setSuggestions([]);
    if (window.innerWidth < 1024) setShowSidebar(false);
  };

  const deleteThread = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const filtered = threads.filter(t => t.id !== id);
    if (filtered.length === 0) {
      const resetId = 'reset';
      setThreads([{ id: resetId, title: 'New Session', messages: [], mode: 'roast', lastUpdate: Date.now() }]);
      setActiveThreadId(resetId);
    } else {
      setThreads(filtered);
      if (activeThreadId === id) setActiveThreadId(filtered[0].id);
    }
  };

  const toggleFavorite = (messageId: string) => {
    setThreads(prev => prev.map(t => ({
      ...t,
      messages: t.messages.map(m => m.id === messageId ? { ...m, isFavorite: !m.isFavorite } : m)
    })));
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => { setAttachments(prev => [...prev, reader.result as string]); };
      reader.readAsDataURL(file);
    }
  };

  const handleSendMessage = async (e?: React.FormEvent, overrideText?: string) => {
    if (e) e.preventDefault();
    const text = (overrideText || inputText).trim();
    if (!text && attachments.length === 0) return;

    const userMsg: Message = { id: Date.now().toString(), role: Role.USER, text, timestamp: Date.now(), attachments };
    const updatedMessages = [...activeThread.messages, userMsg];
    
    setThreads(prev => prev.map(t => t.id === activeThreadId ? { ...t, messages: updatedMessages, lastUpdate: Date.now() } : t));
    setInputText('');
    setAttachments([]);
    setIsTyping(true);

    try {
      if (text.toLowerCase().startsWith('/gen ') || text.toLowerCase().startsWith('generate ')) {
        const prompt = text.replace(/^(generate |\/\w+ )/i, '');
        const imageUrl = await vulcanService.generateImage(prompt);
        const aiMsg: Message = { id: 'img-'+Date.now(), role: Role.MODEL, text: imageUrl, timestamp: Date.now(), isImageGeneration: true };
        setThreads(prev => prev.map(t => t.id === activeThreadId ? { ...t, messages: [...t.messages, aiMsg] } : t));
        setIsTyping(false);
        return;
      }

      vulcanService.initChat(persona, updatedMessages);
      let fullText = '';
      const stream = vulcanService.sendMessageStream(text, userMsg.attachments);
      const aiId = 'ai-'+Date.now();
      const newAiMsg: Message = { id: aiId, role: Role.MODEL, text: '', timestamp: Date.now() };
      setThreads(prev => prev.map(t => t.id === activeThreadId ? { ...t, messages: [...t.messages, newAiMsg] } : t));

      for await (const chunk of stream) {
        fullText += chunk.text;
        setThreads(prev => prev.map(t => t.id === activeThreadId ? { 
          ...t, 
          messages: t.messages.map(m => m.id === aiId ? { ...m, text: fullText, groundingMetadata: chunk.grounding } : m) 
        } : t));
      }
      
      const suggs = await vulcanService.getSuggestions([...updatedMessages, { ...newAiMsg, text: fullText }], persona.mode);
      setSuggestions(suggs);
    } catch (err) { console.error(err); } finally { setIsTyping(false); }
  };

  const stopLiveSession = useCallback(() => {
    if (liveSessionRef.current) liveSessionRef.current.close();
    audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    audioSourcesRef.current.clear();
    setIsLiveActive(false);
    setIsModelSpeaking(false);
    setTranscriptions({ input: '', output: '' });
  }, []);

  const startLiveSession = async () => {
    try {
      if (!audioContextRef.current) audioContextRef.current = new AudioContext({ sampleRate: 24000 });
      if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const source = inputCtx.createMediaStreamSource(stream);
      const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
      const sessionPromise = vulcanService.connectLive(persona, {
        onopen: () => { setIsLiveActive(true); source.connect(scriptProcessor); scriptProcessor.connect(inputCtx.destination); },
        onmessage: async (msg: any) => {
          const audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
          if (audio && audioContextRef.current) {
            setIsModelSpeaking(true);
            const buffer = await decodeAudioData(decodePCM(audio), audioContextRef.current, 24000, 1);
            const node = audioContextRef.current.createBufferSource();
            node.buffer = buffer; node.connect(audioContextRef.current.destination);
            node.onended = () => { audioSourcesRef.current.delete(node); if (audioSourcesRef.current.size === 0) setIsModelSpeaking(false); };
            node.start(); audioSourcesRef.current.add(node);
          }
          if (msg.serverContent?.inputTranscription) setTranscriptions(p => ({ ...p, input: msg.serverContent.inputTranscription.text }));
          if (msg.serverContent?.outputTranscription) setTranscriptions(p => ({ ...p, output: p.output + msg.serverContent.outputTranscription.text }));
        },
        onclose: stopLiveSession, onerror: stopLiveSession
      });
      scriptProcessor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        let sum = 0; for(let i=0; i<data.length; i++) sum += data[i]*data[i];
        setUserVolume(Math.sqrt(sum/data.length));
        const int16 = new Int16Array(data.length);
        for (let i = 0; i < data.length; i++) int16[i] = data[i] * 32768;
        sessionPromise.then(s => s?.sendRealtimeInput({ media: { data: encodePCM(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } }));
      };
    } catch (e) { console.error(e); setIsLiveActive(false); }
  };

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [activeThread.messages, isTyping, showOnlyFavorites, messageSearchQuery]);

  // Filter logic for conversations (sidebar)
  const filteredThreads = threads.filter(t => 
    t.title.toLowerCase().includes(threadSearchQuery.toLowerCase()) || 
    t.messages.some(m => m.text.toLowerCase().includes(threadSearchQuery.toLowerCase()))
  );

  // Filter logic for messages in current chat
  const filteredMessages = activeThread.messages.filter(m => {
    const matchesSearch = m.text.toLowerCase().includes(messageSearchQuery.toLowerCase());
    const matchesFavorite = showOnlyFavorites ? m.isFavorite : true;
    return matchesSearch && matchesFavorite;
  });

  return (
    <div className={`flex h-screen w-full overflow-hidden ${theme === 'obsidian' ? 'theme-obsidian' : ''} bg-[var(--bg-primary)]`}>
      {/* Mobile Drawer Backdrop - Higher Z-Index */}
      <div 
        className={`fixed inset-0 z-[200] bg-black/90 backdrop-blur-sm lg:hidden transition-opacity duration-300 ${showSidebar ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} 
        onClick={() => setShowSidebar(false)} 
      />

      {/* Futuristic Sidebar Drawer */}
      <aside className={`fixed lg:relative z-[210] h-full transition-all duration-500 transform glass-card border-r border-white/10 ${showSidebar ? 'w-80 translate-x-0' : 'w-0 -translate-x-full lg:w-80 lg:translate-x-0'}`}>
        <div className="flex flex-col h-full w-full overflow-hidden bg-[var(--bg-secondary)] shadow-2xl">
          <div className="p-6 pb-2 space-y-4">
            <button onClick={createNewChat} className="group relative w-full py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl transition-all active:scale-95 overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-purple-500/10 to-cyan-500/10 opacity-0 group-hover:opacity-100 transition-opacity" />
              <span className="relative mono text-[11px] font-black tracking-[0.3em] uppercase">Initialize_Session</span>
            </button>
            
            {/* Sidebar Thread Search */}
            <div className="relative">
              <input 
                type="text" 
                placeholder="SEARCH_HISTORY..." 
                value={threadSearchQuery}
                onChange={(e) => setThreadSearchQuery(e.target.value)}
                className="w-full bg-white/5 border border-white/5 rounded-xl py-2 px-10 text-[10px] mono text-white focus:outline-none focus:border-purple-500/30 transition-all placeholder:text-white/10"
              />
              <svg width="12" height="12" className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-3">
            {filteredThreads.sort((a,b) => b.lastUpdate - a.lastUpdate).map(t => (
              <div 
                key={t.id} 
                onClick={() => { setActiveThreadId(t.id); if (window.innerWidth < 1024) setShowSidebar(false); }}
                className={`group relative flex items-center justify-between p-4 rounded-2xl transition-all border cursor-pointer ${t.id === activeThreadId ? 'bg-white/10 border-white/20' : 'hover:bg-white/5 border-transparent'}`}
              >
                <div className="flex flex-col min-w-0 flex-1 pr-2">
                  <span className={`text-[12px] font-bold truncate mb-1.5 ${t.id === activeThreadId ? 'text-white' : 'text-white/40'}`}>
                    {t.messages[0]?.text?.slice(0, 32) || 'New_Memory_Stream'}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-[7px] mono text-purple-400 font-black uppercase tracking-[0.1em] bg-purple-500/10 px-1.5 py-0.5 rounded border border-purple-500/20">{t.mode}</span>
                    <span className="text-[7px] mono text-white/10 font-bold uppercase">{new Date(t.lastUpdate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>
                <button onClick={(e) => deleteThread(t.id, e)} className="p-2 text-white/10 hover:text-red-500 transition-all shrink-0">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            ))}
            {filteredThreads.length === 0 && (
              <div className="py-10 text-center text-[10px] mono text-white/10 uppercase tracking-widest">No_Matches_Found</div>
            )}
          </div>

          <div className="p-6 border-t border-white/5 bg-black/60">
             <button onClick={() => setShowSettings(true)} className="flex items-center justify-center gap-3 w-full py-4 rounded-2xl border border-white/10 bg-white/5 text-white/30 hover:text-white hover:border-white/30 hover:bg-white/10 transition-all font-black mono text-[10px] tracking-widest">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                CORE_CONFIG
             </button>
          </div>
        </div>
      </aside>

      {/* Main Experience Layer */}
      <div className="flex-1 flex flex-col relative h-full overflow-hidden bg-[var(--bg-primary)]">
        <Header 
          theme={theme}
          onToggleTheme={() => setTheme(prev => prev === 'neon' ? 'obsidian' : 'neon')}
          onLanguageChange={(lang) => setPersona({ ...persona, language: lang })}
          onToggleLive={() => isLiveActive ? stopLiveSession() : startLiveSession()}
          onToggleSidebar={() => setShowSidebar(!showSidebar)}
          isLiveActive={isLiveActive}
          currentLanguage={persona.language}
          onShowSettings={() => setShowSettings(true)} 
          onClearChat={() => { setThreads(prev => prev.map(t => t.id === activeThreadId ? { ...t, messages: [] } : t)); }}
          hasMessages={activeThread.messages.length > 0}
          isTyping={isTyping}
        />

        {/* Message Search Sub-Header */}
        {activeThread.messages.length > 0 && (
          <div className="w-full px-4 sm:px-12 py-2 flex items-center gap-4 bg-black/20 border-b border-white/5 backdrop-blur-md z-50">
             <div className="flex-1 flex items-center gap-2">
                <button 
                  onClick={() => setShowOnlyFavorites(!showOnlyFavorites)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[9px] mono font-black transition-all ${showOnlyFavorites ? 'bg-yellow-500/20 border-yellow-500/40 text-yellow-400' : 'bg-white/5 border-white/5 text-white/30 hover:text-white'}`}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill={showOnlyFavorites ? "currentColor" : "none"} stroke="currentColor" strokeWidth="3"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg>
                  {showOnlyFavorites ? 'SHOWING_BOOKMARKS' : 'SHOW_BOOKMARKS'}
                </button>
                <div className="h-4 w-[1px] bg-white/10 mx-1" />
                <div className={`flex-1 flex items-center gap-2 bg-white/5 rounded-lg px-3 transition-all ${isSearchingInChat ? 'border border-purple-500/30 ring-1 ring-purple-500/10' : 'border border-transparent'}`}>
                  <svg width="10" height="10" className="text-white/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                  <input 
                    type="text" 
                    placeholder="FIND_IN_THREAD..." 
                    value={messageSearchQuery}
                    onFocus={() => setIsSearchingInChat(true)}
                    onBlur={() => setIsSearchingInChat(false)}
                    onChange={(e) => setMessageSearchQuery(e.target.value)}
                    className="w-full bg-transparent border-none text-[10px] mono text-white focus:outline-none placeholder:text-white/10"
                  />
                  {messageSearchQuery && (
                    <button onClick={() => setMessageSearchQuery('')} className="text-white/20 hover:text-white"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
                  )}
                </div>
             </div>
             <span className="text-[8px] mono text-white/10 hidden sm:inline">{filteredMessages.length}_SEGMENTS_FOUND</span>
          </div>
        )}

        {/* Message Stream */}
        <main ref={scrollRef} className="flex-1 overflow-y-auto w-full custom-scrollbar px-4 sm:px-12 pt-8 pb-72">
           <div className="max-w-4xl mx-auto flex flex-col min-h-full">
              {activeThread.messages.length === 0 && (
                <div className="flex-1 flex flex-col items-center justify-center opacity-[0.03] sm:opacity-[0.07] pointer-events-none select-none text-center animate-fade-in py-32">
                  <h2 className="cinzel text-[5rem] sm:text-[12rem] font-black leading-none mb-4 text-glow tracking-tighter uppercase">{persona.mode}</h2>
                  <p className="mono text-[10px] sm:text-sm tracking-[1em] uppercase font-black">SYSTEM_STBY_MODE</p>
                </div>
              )}
              <div className="space-y-12">
                {filteredMessages.map(msg => (
                  <ChatMessage 
                    key={msg.id} 
                    message={msg} 
                    onToggleFavorite={toggleFavorite}
                  />
                ))}
                {filteredMessages.length === 0 && activeThread.messages.length > 0 && (
                  <div className="flex-1 flex flex-col items-center justify-center py-20 opacity-30">
                    <p className="mono text-[10px] uppercase tracking-[0.4em] font-black">No_Matching_Messages_In_Buffer</p>
                  </div>
                )}
                {isTyping && (
                  <div className="flex items-center gap-4 px-6 py-3 animate-pulse">
                    <div className="flex gap-1.5">
                      <div className="w-1.5 h-1.5 bg-purple-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
                      <div className="w-1.5 h-1.5 bg-purple-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
                      <div className="w-1.5 h-1.5 bg-purple-500 rounded-full animate-bounce" />
                    </div>
                    <span className="text-[10px] mono text-purple-500/40 font-black uppercase tracking-[0.4em]">PROCESSING_DATA...</span>
                  </div>
                )}
              </div>
           </div>
        </main>

        {/* Floating Input Dock */}
        <div className="absolute bottom-0 left-0 right-0 p-4 sm:p-12 pointer-events-none z-[100] bg-gradient-to-t from-[var(--bg-primary)] via-[var(--bg-primary)] to-transparent">
          <div className="max-w-3xl mx-auto space-y-4 pointer-events-auto">
             {/* Quick Actions */}
             <div className="flex gap-2 items-center overflow-x-auto no-scrollbar py-1">
                <button 
                  onClick={() => setPersona({ ...persona, useSearch: !persona.useSearch })}
                  className={`px-4 py-2.5 rounded-full border text-[9px] mono font-black uppercase tracking-widest transition-all ${persona.useSearch ? 'bg-cyan-500 text-white border-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.4)]' : 'bg-white/5 text-white/30 border-white/5 hover:border-white/10'}`}
                >WEB_SEARCH</button>
                <button 
                  onClick={() => setPersona({ ...persona, useMaps: !persona.useMaps })}
                  className={`px-4 py-2.5 rounded-full border text-[9px] mono font-black uppercase tracking-widest transition-all ${persona.useMaps ? 'bg-green-500 text-white border-green-400 shadow-[0_0_15px_rgba(34,197,94,0.4)]' : 'bg-white/5 text-white/30 border-white/5 hover:border-white/10'}`}
                >MAPS_INTEL</button>
                <div className="h-4 w-[1px] bg-white/10 mx-2 shrink-0" />
                {suggestions.map((s, i) => (
                  <button key={i} onClick={() => handleSendMessage(undefined, s)} className="px-4 py-2.5 whitespace-nowrap bg-white/5 border border-white/5 rounded-full text-[9px] mono text-purple-400 hover:text-white hover:bg-purple-600/20 transition-all font-black uppercase tracking-widest">{s}</button>
                ))}
             </div>

             {/* Command Input */}
             <div className="relative group">
                {attachments.length > 0 && (
                   <div className="flex gap-3 mb-4 animate-fade-up">
                     {attachments.map((at, i) => (
                       <div key={i} className="relative ring-1 ring-purple-500/50 rounded-2xl overflow-hidden shadow-2xl">
                         <img src={at} className="w-16 h-16 sm:w-20 sm:h-20 object-cover" />
                         <button onClick={() => setAttachments(attachments.filter((_, idx) => idx !== i))} className="absolute top-1 right-1 bg-black/80 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center backdrop-blur-md transition-colors text-[10px]">✕</button>
                       </div>
                     ))}
                   </div>
                 )}

                <form onSubmit={handleSendMessage} className="relative flex items-center bg-black/90 border border-white/10 rounded-[2.5rem] p-2 sm:p-3 shadow-[0_40px_80px_rgba(0,0,0,0.9)] focus-within:border-purple-500/50 transition-all backdrop-blur-3xl">
                  <label className="w-12 h-12 flex items-center justify-center cursor-pointer text-white/20 hover:text-purple-400 transition-colors shrink-0">
                    <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                  </label>
                  
                  <input 
                    type="text" value={inputText} onChange={e => setInputText(e.target.value)}
                    placeholder={attachments.length > 0 ? "Analyzing_Buffer..." : `Input_Command_${persona.mode.toUpperCase()}...`}
                    className="flex-1 bg-transparent border-none text-white px-3 focus:outline-none text-sm sm:text-base placeholder:text-white/10 font-medium min-w-0"
                  />

                  <button 
                    type="submit" 
                    disabled={(!inputText.trim() && attachments.length === 0) || isTyping} 
                    className="w-12 h-12 bg-purple-600 hover:bg-purple-500 text-white rounded-[1.5rem] flex items-center justify-center shadow-2xl active:scale-90 transition-all disabled:opacity-20 shrink-0"
                  >
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                  </button>
                </form>
             </div>
          </div>
        </div>
      </div>

      {isLiveActive && (
        <VoiceOverlay 
          onClose={stopLiveSession}
          inputTranscription={transcriptions.input}
          outputTranscription={transcriptions.output}
          isModelSpeaking={isModelSpeaking}
          isFxEnabled={false}
          onToggleFx={() => {}}
          userVolume={userVolume}
          currentLanguage={persona.language}
          onLanguageChange={(lang) => setPersona({ ...persona, language: lang })}
          mode={persona.mode}
        />
      )}

      {showSettings && (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center p-6 bg-black/95 backdrop-blur-3xl animate-fade-in">
          <div className="w-full max-w-md glass-card border-2 border-purple-500/20 rounded-[3rem] p-8 sm:p-10 shadow-3xl animate-fade-up bg-black">
            <h3 className="text-[11px] font-black tracking-[0.6em] text-purple-400 uppercase mono mb-10 text-center">INTERFACE_CORE</h3>
            <div className="space-y-10">
              <div>
                <label className="text-[9px] mono uppercase text-white/30 block mb-6 font-black tracking-widest text-center">Neural_Identity</label>
                <div className="grid grid-cols-2 gap-3">
                  {(['roast', 'girlfriend', 'boyfriend', 'mentor', 'scientist', 'coder'] as AppMode[]).map(m => (
                    <button 
                      key={m} 
                      onClick={() => setPersona({ ...persona, mode: m, ...MODE_DEFAULTS[m] })}
                      className={`py-4 rounded-2xl text-[9px] mono font-black border transition-all uppercase tracking-widest ${persona.mode === m ? 'bg-purple-600 border-purple-400 text-white shadow-2xl' : 'bg-white/5 border-white/5 text-white/30 hover:bg-white/10'}`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex justify-between mb-4">
                   <label className="text-[9px] mono uppercase text-white/30 font-black tracking-widest">Entropy_Factor</label>
                   <span className="text-[9px] mono text-purple-500 font-black">{persona.sarcasm}%</span>
                </div>
                <input type="range" min="0" max="100" value={persona.sarcasm} onChange={e => setPersona({ ...persona, sarcasm: +e.target.value })} className="w-full h-1.5 bg-white/5 rounded-full appearance-none accent-purple-500 cursor-pointer" />
              </div>
            </div>
            <button onClick={() => setShowSettings(false)} className="w-full mt-12 py-5 bg-purple-600 text-white font-black uppercase text-[11px] tracking-[0.5em] rounded-3xl shadow-3xl active:scale-95 transition-all">SAVE_RECONFIGURE</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
