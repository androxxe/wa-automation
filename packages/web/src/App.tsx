import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from '@/components/layout/Layout'
import Dashboard from '@/pages/Dashboard'
import Import from '@/pages/Import'
import Contacts from '@/pages/Contacts'
import Campaigns from '@/pages/Campaigns'
import NewCampaign from '@/pages/NewCampaign'
import CampaignDetail from '@/pages/CampaignDetail'
import Responses from '@/pages/Responses'
import Settings from '@/pages/Settings'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="import" element={<Import />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="campaigns" element={<Campaigns />} />
        <Route path="campaigns/new" element={<NewCampaign />} />
        <Route path="campaigns/:id" element={<CampaignDetail />} />
        <Route path="responses" element={<Responses />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
