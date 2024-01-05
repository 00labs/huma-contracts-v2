// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ERC20, ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/draft-ERC20Permit.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

contract MockToken is ERC20Permit, IERC165 {
    constructor() ERC20Permit("TestToken") ERC20("TestToken", "USDC") {
        _mint(msg.sender, 1000 * 10 ** decimals());
    }

    function give1000To(address to) external {
        _mint(to, 1000 * 10 ** decimals());
    }

    function give100000To(address to) external {
        _mint(to, 100000 * 10 ** decimals());
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function decimals() public view virtual override returns (uint8) {
        return 6;
    }

    function supportsInterface(bytes4 interfaceId) external view virtual override returns (bool) {
        return interfaceId == 0x36372b07 || interfaceId == 0x01ffc9a7;
    }
}