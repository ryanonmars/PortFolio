import { createRoot } from 'react-dom/client';
import { BoardStudio } from './board/BoardStudio.js';
import './styles.css';
const root = document.getElementById('root');
if (!root) throw new Error('Application root missing');
createRoot(root).render(<BoardStudio />);
