import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const AddOnsPage: React.FC = () => {
  const navigate = useNavigate();
  useEffect(() => {
    navigate('/owner/plans?tab=addons', { replace: true });
  }, [navigate]);
  return null;
};

export default AddOnsPage;
