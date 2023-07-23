// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig} from "./CreditStructs.sol";
import {CreditFacility} from "./CreditFacility.sol";
import {Errors} from "../Errors.sol";

/**
 * SingleLineCreditFacility provides a single revolving credit line to the borrower.
 * All the receivables that the borrower sells to the facility are tracked against one
 * credit line.
 */
contract MultiLinesCreditFacility is CreditFacility {
    function getCreditHash(
        address /*borrower*/
    ) public view virtual override returns (bytes32 /*creditHash*/) {
        {
            revert Errors.todo();
            //return keccak256(abi.encode(address(this), borrower));
        }
    }

    function getCreditHash(
        address borrower,
        address /*receivableAsset*/,
        uint256 /*receivableId*/
    ) external view virtual override returns (bytes32 creditHash) {
        {
            return keccak256(abi.encode(address(this), borrower));
        }
    }
}
