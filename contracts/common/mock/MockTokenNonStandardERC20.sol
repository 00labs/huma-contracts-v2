// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

/**
 * @notice A non-standard ERC20 token that mimics USDT where `transfer()` returns no values
 * and certain failures are realized using `assert()`s rather than `require()` and `revert()`s.
 */
contract MockTokenNonStandardERC20 {
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    function approve(address spender, uint256 amount) external returns (bool) {
        require((amount == 0) || (_allowances[msg.sender][spender] == 0));

        _allowances[msg.sender][spender] = amount;
        return true;
    }

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
    }

    function burn(address from, uint256 amount) external {
        uint256 balance = _balances[from];
        assert(balance >= amount);
        _balances[from] = balance - amount;
    }

    function transfer(address to, uint256 amount) external {
        uint256 balance = _balances[msg.sender];
        assert(balance >= amount);
        _balances[msg.sender] = balance - amount;
        _balances[to] += amount;
    }

    function transferFrom(address from, address to, uint amount) external {
        uint256 allowance = _allowances[from][msg.sender];
        assert(allowance >= amount);

        _balances[from] -= amount;
        _balances[to] += amount;
    }

    function allowance(address owner, address spender) external view returns (uint256 remaining) {
        return _allowances[owner][spender];
    }

    function balanceOf(address owner) external view returns (uint256 balance) {
        return _balances[owner];
    }

    function decimals() public view returns (uint8) {
        return 6;
    }
}
