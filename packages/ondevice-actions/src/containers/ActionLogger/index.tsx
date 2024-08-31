import React, { useState, useEffect } from 'react';
import deepEqual from 'fast-deep-equal';
import { addons } from '@storybook/manager-api';
import { SET_CURRENT_STORY, SELECT_STORY } from '@storybook/core-events';
import { ActionDisplay, EVENT_ID } from '@storybook/addon-actions';
import { ActionLogger as ActionLoggerComponent } from '../../components/ActionLogger';

interface ActionLoggerProps {
  active: boolean;
}

const safeDeepEqual = (a: any, b: any): boolean => {
  try {
    return deepEqual(a, b);
  } catch (e) {
    return false;
  }
};

const ActionLogger = ({ active }: ActionLoggerProps) => {
  const [actions, setActions] = useState<ActionDisplay[]>([]);
  const clearActions = () => setActions([]);
  const clearActionsOnStoryChange = actions.length > 0 && actions[0].options.clearOnStoryChange;

  useEffect(() => {
    const handleStoryChange = () => {
      console.log('handleStoryChange');
      if (clearActionsOnStoryChange) {
        clearActions();
      }
    };

    const channel = addons.getChannel();
    channel.addListener(SET_CURRENT_STORY, handleStoryChange);
    channel.addListener(SELECT_STORY, handleStoryChange);

    return () => {
      channel.removeListener(SET_CURRENT_STORY, handleStoryChange);
      channel.removeListener(SELECT_STORY, handleStoryChange);
    };
  }, [clearActionsOnStoryChange]);

  useEffect(() => {
    const addAction = (action: ActionDisplay) => {
      setActions((prevState: ActionDisplay[]) => {
        if (prevState.find((a) => a.id === action.id)) {
          return prevState;
        }

        const newActions = [...prevState];
        const previous = newActions.length && newActions[0];
        if (previous && safeDeepEqual(previous.data, action.data)) {
          previous.count++;
        } else {
          action.count = 1;
          newActions.unshift(action);
        }
        return newActions.slice(0, action.options.limit);
      });
    };

    const channel = addons.getChannel();
    channel.addListener(EVENT_ID, addAction);

    return () => {
      channel.removeListener(EVENT_ID, addAction);
    };
  }, []);

  return active ? <ActionLoggerComponent actions={actions} onClear={clearActions} /> : null;
};

export default ActionLogger;
