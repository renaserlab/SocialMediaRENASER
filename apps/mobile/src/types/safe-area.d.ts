import 'react-native-safe-area-context';
import { StyleProp, ViewStyle } from 'react-native';

declare module 'react-native-safe-area-context' {
  interface NativeSafeAreaViewProps {
    style?: StyleProp<ViewStyle>;
  }
}
