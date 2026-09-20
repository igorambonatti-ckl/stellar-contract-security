import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Overview } from './pages/Overview';
import { Matriz } from './pages/Matriz';
import { Achados } from './pages/Achados';
import { Metodo } from './pages/Metodo';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Overview />} />
        <Route path="/matriz" element={<Matriz />} />
        <Route path="/achados" element={<Achados />} />
        <Route path="/metodo" element={<Metodo />} />
      </Route>
    </Routes>
  );
}
