import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Pipeline } from './pages/Pipeline';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Pipeline />} />
      </Route>
    </Routes>
  );
}
