import ReactDOM from 'react-dom/client'
import '@fontsource/ibm-plex-mono/400.css'
import '@arco-design/web-react/dist/css/arco.css'
import AppRoot from './app/AppRoot'
import './styles/tokens.css'
import './styles/globals.css'
import './styles/app-shell.css'
import './styles/modules.css'
import './index.css'
import './styles/stitch-fidelity.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppRoot />,
)
