import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { CreateGamePage } from './pages/CreateGamePage'
import { JoinPage } from './pages/JoinPage'
import { LobbyPage } from './pages/LobbyPage'
import { WordEntryPage } from './pages/WordEntryPage'
import { GamePage } from './pages/GamePage'
import { ResultsPage } from './pages/ResultsPage'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/create" element={<CreateGamePage />} />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/lobby/:joinCode" element={<LobbyPage />} />
        <Route path="/lobby/:joinCode/words" element={<WordEntryPage />} />
        <Route path="/game/:joinCode" element={<GamePage />} />
        <Route path="/game/:joinCode/results" element={<ResultsPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
