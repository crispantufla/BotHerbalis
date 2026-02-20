import re

def main():
    with open('src/flows/salesFlow.js', 'r', encoding='utf-8') as f:
        content = f.read()

    # We want to find blocks like:
    #         await sendMessageWithDelay(userId, msg);
    #         currentState.history.push({ role: 'bot', content: msg });
    #         _setStep(currentState, 'waiting_preference');
    #         saveState();
    
    # And change them to:
    #         currentState.history.push({ role: 'bot', content: msg });
    #         _setStep(currentState, 'waiting_preference');
    #         saveState();
    #         await sendMessageWithDelay(userId, msg);
    
    # We will use a regex that matches `await sendMessageWithDelay(...);` 
    # followed by whitespace, and then 1 to 4 statements that modify state.
    
    # state mutations we look for:
    # currentState.history.push(...)
    # _setStep(...)
    # currentState.step = ...
    # saveState()
    
    pattern = re.compile(
        r'([ \t]*)(await sendMessageWithDelay\([^;]+;\)\n)'
        r'((?:[ \t]*(?:currentState\.history\.push|currentState\.step|_setStep|saveState)[^;]+;\n)+)',
        re.MULTILINE
    )
    
    def replacer(match):
        indent = match.group(1)
        send_msg = match.group(2)
        mutations = match.group(3)
        # mutations already have their own indentation/newlines
        # We put mutations first, then the send_msg with its original indent
        return f"{mutations}{indent}{send_msg}"
        
    new_content, count = pattern.subn(replacer, content)
    print(f"Replaced {count} occurrences of race conditions.")
    
    with open('src/flows/salesFlow.js', 'w', encoding='utf-8') as f:
        f.write(new_content)

if __name__ == '__main__':
    main()
