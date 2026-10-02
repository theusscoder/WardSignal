import React from 'react'
import ReactDOM from 'react-dom/client'
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import App from './App'
import './styles.css'

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#147d78', dark: '#106662', light: '#e2f2ef' },
    secondary: { main: '#5f7080' },
    success: { main: '#237b61' },
    warning: { main: '#b16b14' },
    error: { main: '#bf4b48' },
    background: { default: '#f4f7f7', paper: '#ffffff' },
    text: { primary: '#192c36', secondary: '#667985' },
    divider: '#e6edef',
  },
  typography: {
    fontFamily: 'DM Sans, sans-serif',
    h1: { fontFamily: 'Manrope, sans-serif', fontWeight: 800, fontSize: '1.78rem', letterSpacing: '-0.045em', lineHeight: 1.18 },
    h2: { fontFamily: 'Manrope, sans-serif', fontWeight: 750, fontSize: '1.35rem', letterSpacing: '-0.035em' },
    h3: { fontFamily: 'Manrope, sans-serif', fontWeight: 750, fontSize: '1rem', letterSpacing: '-0.025em' },
    button: { fontWeight: 700, textTransform: 'none', letterSpacing: '-0.01em' },
    body2: { lineHeight: 1.55 },
  },
  shape: { borderRadius: 13 },
  shadows: ['none', '0 1px 2px rgba(30,55,63,.045)', '0 5px 18px rgba(30,55,63,.055)', ...Array(23).fill('0 12px 32px rgba(30,55,63,.09)')] as never,
  components: {
    MuiButton: { styleOverrides: { root: { borderRadius: 10, paddingInline: 15, minHeight: 39, boxShadow: 'none' }, containedPrimary: { '&:hover': { boxShadow: '0 5px 14px rgba(20,125,120,.17)' } } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiCard: { styleOverrides: { root: { border: '1px solid #e6edef', borderRadius: 16, boxShadow: '0 2px 8px rgba(35,59,68,.025)' } } },
    MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 10, backgroundColor: '#fff', '& fieldset': { borderColor: '#e2eaec' }, '&:hover fieldset': { borderColor: '#b8cccf' }, '&.Mui-focused fieldset': { borderWidth: '1px', borderColor: '#147d78' } } } },
    MuiChip: { styleOverrides: { root: { borderRadius: 8, fontWeight: 700, letterSpacing: '-0.015em' } } },
    MuiDialog: { styleOverrides: { paper: { borderRadius: 18, border: '1px solid #e6edef' } } },
    MuiCssBaseline: { styleOverrides: { body: { minWidth: 340, fontFeatureSettings: '"ss01" on' }, '*:focus-visible': { outline: '3px solid rgba(20,125,120,.28)', outlineOffset: 2 } } },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}><CssBaseline /><App /></ThemeProvider>
  </React.StrictMode>,
)
