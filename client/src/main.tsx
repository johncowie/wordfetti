import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { CreateGamePage } from './pages/CreateGamePage'
import { JoinPage } from './pages/JoinPage'
import { LobbyPage } from './pages/LobbyPage'
import { WordEntryPage } from './pages/WordEntryPage'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/create" element={<CreateGamePage />} />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/game/:joinCode" element={<LobbyPage />} />
        <Route path="/game/:joinCode/words" element={<WordEntryPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
