// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {PoolConfig} from "./PoolConfig.sol";

contract PoolVault is IPoolVault {
    PoolConfig public poolConfig;
    IERC20 public asset;

    uint256 public reserveAssets;

    function deposit(address from, uint256 amount) external {
        asset.transferFrom(from, address(this), amount);
    }

    function withdraw(address to, uint256 amount) external {
        asset.transfer(to, amount);
    }

    function setReserveAssets(uint256 assets) external {
        reserveAssets = assets;
    }

    function getAvailableLiquidity() external view returns (uint256 assets) {
        assets = asset.balanceOf(address(this));

        assets = assets > reserveAssets ? assets - reserveAssets : 0;
    }

    function getAvailableReservation() external view returns (uint256 assets) {
        assets = asset.balanceOf(address(this));

        assets = assets < reserveAssets ? assets : reserveAssets;
    }
}
