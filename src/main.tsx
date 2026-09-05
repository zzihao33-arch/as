import ReactDOM from 'react-dom/client'
import '@fontsource/ibm-plex-mono/400.css'
import 'tdesign-react/es/style/index.css'
import AppRoot from './app/AppRoot'
import './styles/tokens.css'
import './styles/globals.css'
import './styles/app-shell.css'
import './styles/modules.css'
import './index.css'
import './styles/stitch-fidelity.css'
import './styles/intercept-layout.css'
import './styles/attendance-layout.css'
import './styles/form-controls.css'
import './styles/tdesign-accounts.css'
import './styles/tdesign-workbench.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppRoot />,
)
