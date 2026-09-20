import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Contrato } from './pages/Contrato';
import { Invariantes } from './pages/Invariantes';
import { Harness } from './pages/Harness';
import { Execucao } from './pages/Execucao';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Contrato />} />
        <Route path="/invariantes" element={<Invariantes />} />
        <Route path="/harness" element={<Harness />} />
        <Route path="/execucao" element={<Execucao />} />
      </Route>
    </Routes>
  );
}
