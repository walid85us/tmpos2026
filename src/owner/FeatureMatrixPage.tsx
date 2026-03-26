import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const FeatureMatrixPage: React.FC = () => {
  const navigate = useNavigate();
  useEffect(() => {
    navigate('/owner/plans?tab=features', { replace: true });
  }, [navigate]);
  return null;
};

export default FeatureMatrixPage;
