import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

import 'leaflet/dist/leaflet.css';
// Leaflet'in varsayılan iğnesini gömülü SVG ile değiştirir (kırık ikon düzeltmesi).
// Leaflet CSS'inden SONRA gelmeli.
import './igne';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
