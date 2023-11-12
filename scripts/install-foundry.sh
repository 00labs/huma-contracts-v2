# Check if Bash is the current shell
if [ -n "$BASH_VERSION" ]; then
    # Check if .foundry/bin is already in the PATH
    if [[ ":$PATH:" != *":$HOME/.foundry/bin:"* ]]; then
        # Add the PATH modification to the user's profile
        echo 'export PATH="$HOME/.foundry/bin:$PATH"' >> ~/.bashrc
    fi
fi

# Check if Zsh is the current shell
if [ -n "$ZSH_VERSION" ]; then
    # Check if .foundry/bin is already in the PATH
    if [[ ":$PATH:" != *":$HOME/.foundry/bin:"* ]]; then
        # Add the PATH modification to the user's profile
        echo 'export PATH="$HOME/.foundry/bin:$PATH"' >> ~/.zshrc
    fi
fi

curl -L https://foundry.paradigm.xyz | bash
export PATH="$HOME/.foundry/bin:$PATH"
foundryup
